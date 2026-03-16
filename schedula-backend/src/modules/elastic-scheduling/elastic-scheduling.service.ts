import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExpandSessionDto, ShrinkSessionDto } from './dto/elastic.dto';

@Injectable()
export class ElasticSchedulingService {
  constructor(private readonly prisma: PrismaService) { }

  private timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  private minutesToTime(minutes: number): string {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  // ═══════════════════════════════════════════════════
  //  EXPAND SESSION (Wave + Stream)
  // ═══════════════════════════════════════════════════
  async expandSession(userId: string, dto: ExpandSessionDto) {
    const doctor = await this.prisma.doctor.findUnique({ where: { userId } });
    if (!doctor) throw new NotFoundException('Doctor profile not found');

    const availability = await this.prisma.availability.findUnique({
      where: { id: dto.availabilityId },
      include: { slots: true }
    });

    if (!availability) throw new NotFoundException('Availability block not found');
    if (availability.doctorId !== doctor.id) throw new BadRequestException('Not authorized to modify this session');
    if (!availability.date) throw new BadRequestException('Cannot expand a recurring template. Use custom-availability first.');

    const isWave = availability.scheduleType === 'WAVE';
    const interval = isWave ? availability.slotDuration! : (availability.streamInterval || 15);

    const originalStartMin = this.timeToMinutes(availability.consultingStartTime);
    const originalEndMin = this.timeToMinutes(availability.consultingEndTime);
    const newStartMin = dto.newStartTime ? this.timeToMinutes(dto.newStartTime) : originalStartMin;
    const newEndMin = dto.newEndTime ? this.timeToMinutes(dto.newEndTime) : originalEndMin;

    if (newStartMin > originalStartMin || newEndMin < originalEndMin) {
      throw new BadRequestException('Expand operation cannot shrink the session.');
    }

    const currentMax = availability.slots[0]?.maxAppt || 0;
    const newMaxPerSlot = dto.newMaxPerSlot || currentMax;
    if (newMaxPerSlot < currentMax) throw new BadRequestException('Expand cannot reduce maxPerSlot.');

    const generatedSlots: { startTime: string; endTime: string; maxPerSlot: number }[] = [];

    // Prepend slots
    if (newStartMin < originalStartMin) {
      if ((originalStartMin - newStartMin) % interval !== 0)
        throw new BadRequestException(`Prepended time must be a multiple of ${interval} mins`);
      let cur = newStartMin;
      while (cur < originalStartMin) {
        generatedSlots.push({ startTime: this.minutesToTime(cur), endTime: this.minutesToTime(cur + interval), maxPerSlot: newMaxPerSlot });
        cur += interval;
      }
    }

    // Append slots
    if (newEndMin > originalEndMin) {
      if ((newEndMin - originalEndMin) % interval !== 0)
        throw new BadRequestException(`Appended time must be a multiple of ${interval} mins`);
      let cur = originalEndMin;
      while (cur < newEndMin) {
        generatedSlots.push({ startTime: this.minutesToTime(cur), endTime: this.minutesToTime(cur + interval), maxPerSlot: newMaxPerSlot });
        cur += interval;
      }
    }

    // Extra capacity on existing slots
    const extraCapacity = newMaxPerSlot - currentMax;
    if (extraCapacity > 0) {
      for (const slot of availability.slots) {
        generatedSlots.push({ startTime: slot.startTime, endTime: slot.endTime, maxPerSlot: extraCapacity });
      }
    }

    if (generatedSlots.length === 0) {
      return { message: 'No expansion needed. Parameters matched existing session exactly.' };
    }

    const createdSlots = await this.prisma.$transaction(
      generatedSlots.map(slot =>
        this.prisma.elasticSlot.create({
          data: {
            doctorId: doctor.id,
            availabilityId: availability.id,
            sessionDate: availability.date!,
            startTime: slot.startTime,
            endTime: slot.endTime,
            slotDuration: interval,
            maxPerSlot: slot.maxPerSlot,
            isActive: true
          }
        })
      )
    );

    await this.prisma.availability.update({
      where: { id: availability.id },
      data: {
        consultingStartTime: this.minutesToTime(newStartMin),
        consultingEndTime: this.minutesToTime(newEndMin)
      }
    });

    return {
      scheduleType: availability.scheduleType,
      message: 'Session expanded successfully',
      newSlotsAdded: createdSlots.length,
      slots: createdSlots,
    };
  }

  // ═══════════════════════════════════════════════════
  //  SHRINK SESSION — Fully Automatic Cascade
  //  Option A → Move to remaining future slots
  //  Option B → Reduce slot duration to fit
  //  Option C → Reschedule to same-day or next-day session
  // ═══════════════════════════════════════════════════
  async shrinkSession(userId: string, dto: ShrinkSessionDto) {
    const doctor = await this.prisma.doctor.findUnique({ where: { userId } });
    if (!doctor) throw new NotFoundException('Doctor profile not found');

    const availability = await this.prisma.availability.findUnique({
      where: { id: dto.availabilityId },
      include: {
        slots: {
          include: { appointments: { where: { status: 'CONFIRMED' } } },
          orderBy: { startTime: 'asc' as const }
        }
      }
    });

    if (!availability) throw new NotFoundException('Availability block not found');
    if (availability.doctorId !== doctor.id) throw new BadRequestException('Not authorized');
    if (!availability.date) throw new BadRequestException('Cannot shrink recurring template directly');

    const originalStart = this.timeToMinutes(availability.consultingStartTime);
    const originalEnd = this.timeToMinutes(availability.consultingEndTime);
    const newStart = dto.newStartTime ? this.timeToMinutes(dto.newStartTime) : originalStart;
    const newEnd = dto.newEndTime ? this.timeToMinutes(dto.newEndTime) : originalEnd;

    if (newStart < originalStart || newEnd > originalEnd) {
      throw new BadRequestException('Shrink cannot expand the session.');
    }
    if (newStart >= newEnd) {
      throw new BadRequestException('New start must be before new end.');
    }

    const slotDuration = availability.slotDuration!;
    const now = new Date();

    // ─── Categorize slots ───
    const keptSlots: typeof availability.slots = [];
    const removedSlots: typeof availability.slots = [];
    const affectedAppointments: any[] = [];

    for (const slot of availability.slots) {
      const sStart = this.timeToMinutes(slot.startTime);
      const sEnd = this.timeToMinutes(slot.endTime);
      const isOutside = sStart < newStart || sEnd > newEnd;

      if (isOutside) {
        // Check if doctor already checked in someone in this slot
        const inProgress = slot.appointments.find(a => a.checkedInAt && a.status !== 'COMPLETED');
        if (inProgress) {
          throw new BadRequestException(
            `Cannot shrink: Doctor is currently consulting in slot ${slot.startTime}-${slot.endTime}. Complete or cancel it first.`
          );
        }
        removedSlots.push(slot);
        affectedAppointments.push(...slot.appointments);
      } else {
        keptSlots.push(slot);
      }
    }

    // No affected patients → just shrink
    if (affectedAppointments.length === 0) {
      return this.applyShrink(availability, newStart, newEnd, slotDuration, removedSlots, []);
    }

    // ─── OPTION A: Fit into remaining future kept slots ───
    // Only consider FUTURE kept slots (doctor hasn't consulted them yet)
    const futureKeptSlots = keptSlots.filter(s => {
      // A slot is "future" if its start time hasn't passed yet
      const slotDateTime = new Date(availability.date!);
      const [h, m] = s.startTime.split(':').map(Number);
      slotDateTime.setHours(h, m, 0, 0);
      return slotDateTime > now;
    });

    let emptySpots = 0;
    for (const s of futureKeptSlots) {
      emptySpots += (s.maxAppt - s.appointments.length);
    }

    if (affectedAppointments.length <= emptySpots) {
      // Option A works! Distribute affected patients into future kept slots
      const moveMap = this.distributeToSlots(affectedAppointments, futureKeptSlots);
      return this.applyShrink(availability, newStart, newEnd, slotDuration, removedSlots, moveMap);
    }

    // ─── OPTION B: Reduce slot duration to create more capacity ───
    const windowMinutes = newEnd - newStart;
    const totalPatientsNeeded = futureKeptSlots.reduce((sum, s) => sum + s.appointments.length, 0) + affectedAppointments.length;

    // Find the minimum duration that fits everyone
    // Try reducing by 5-minute increments from current duration
    let optimalDuration = slotDuration;
    for (let tryDur = slotDuration - 5; tryDur >= 5; tryDur -= 5) {
      if (windowMinutes % tryDur !== 0) continue; // Must divide evenly
      const newSlotCount = windowMinutes / tryDur;
      const maxPerSlot = keptSlots[0]?.maxAppt || 5;
      const totalCapacity = newSlotCount * maxPerSlot;
      if (totalCapacity >= totalPatientsNeeded) {
        optimalDuration = tryDur;
        break; // First valid one = least reduction needed
      }
    }

    if (optimalDuration < slotDuration) {
      // Option B works! Reduce duration, rebuild slots, move patients
      const maxPerSlot = keptSlots[0]?.maxAppt || 5;
      const result = await this.applyShrinkWithReducedDuration(
        availability, newStart, newEnd, optimalDuration, maxPerSlot,
        removedSlots, keptSlots, affectedAppointments
      );
      return result;
    }

    // ─── OPTION C: Reschedule to same doctor's other session (same day → next day) ───
    const remainingAfterA = affectedAppointments.length - emptySpots;
    // Move whatever fits into Option A first
    const moveMapPartial = this.distributeToSlots(
      affectedAppointments.slice(0, emptySpots), futureKeptSlots
    );
    const leftoverAppts = affectedAppointments.slice(emptySpots);

    // Find other sessions on the same day
    const sameDayAvailabilities = await this.prisma.availability.findMany({
      where: {
        doctorId: doctor.id,
        date: availability.date!,
        id: { not: availability.id },
      },
      include: {
        slots: {
          include: { appointments: { where: { status: 'CONFIRMED' } } },
          orderBy: { startTime: 'asc' as const }
        }
      }
    });

    let rescheduled: { appointmentId: string; toSlotId: string; type: string }[] = [];
    let stillLeft = [...leftoverAppts];

    // Try same-day other sessions
    for (const otherAvail of sameDayAvailabilities) {
      if (stillLeft.length === 0) break;
      for (const slot of otherAvail.slots) {
        if (stillLeft.length === 0) break;
        const spotsFree = slot.maxAppt - slot.appointments.length;
        if (spotsFree <= 0) continue;
        const toMove = stillLeft.splice(0, spotsFree);
        for (const appt of toMove) {
          rescheduled.push({ appointmentId: appt.id, toSlotId: slot.id, type: 'SAME_DAY_OTHER_SESSION' });
        }
      }
    }

    // If still left, try next available dates
    if (stillLeft.length > 0) {
      const nextDayAvailabilities = await this.prisma.availability.findMany({
        where: {
          doctorId: doctor.id,
          date: { gt: availability.date! },
        },
        include: {
          slots: {
            include: { appointments: { where: { status: 'CONFIRMED' } } },
            orderBy: { startTime: 'asc' as const }
          }
        },
        orderBy: { date: 'asc' },
        take: 7 // Check next 7 days
      });

      for (const nextAvail of nextDayAvailabilities) {
        if (stillLeft.length === 0) break;
        for (const slot of nextAvail.slots) {
          if (stillLeft.length === 0) break;
          const spotsFree = slot.maxAppt - slot.appointments.length;
          if (spotsFree <= 0) continue;
          const toMove = stillLeft.splice(0, spotsFree);
          for (const appt of toMove) {
            rescheduled.push({
              appointmentId: appt.id,
              toSlotId: slot.id,
              type: `NEXT_DAY_${(nextAvail.date as Date).toISOString().split('T')[0]}`
            });
          }
        }
      }
    }

    // Apply everything in a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Move Option A patients
      for (const move of moveMapPartial) {
        await tx.appointment.update({
          where: { id: move.appointmentId },
          data: {
            slotId: move.toSlotId,
            originalSlotId: move.fromSlotId,
            isRescheduled: true
          }
        });
      }

      // 2. Move Option C patients (same day / next day)
      for (const move of rescheduled) {
        await tx.appointment.update({
          where: { id: move.appointmentId },
          data: {
            slotId: move.toSlotId,
            isRescheduled: true
          }
        });
      }

      // 3. Any truly unplaceable patients → add to RescheduleQueue
      for (const appt of stillLeft) {
        await tx.rescheduleQueue.create({
          data: {
            appointmentId: appt.id,
            reason: `Session shrunk from ${availability.consultingStartTime}-${availability.consultingEndTime} to ${this.minutesToTime(newStart)}-${this.minutesToTime(newEnd)}. No available slot found.`,
            priority: 1
          }
        });
      }

      // 4. Delete removed slots
      for (const slot of removedSlots) {
        await tx.availabilitySlot.delete({ where: { id: slot.id } });
      }

      // 5. Deactivate related elastic slots outside window
      await tx.elasticSlot.updateMany({
        where: {
          availabilityId: availability.id,
          OR: [
            { startTime: { lt: this.minutesToTime(newStart) } },
            { endTime: { gt: this.minutesToTime(newEnd) } },
          ]
        },
        data: { isActive: false }
      });

      // 6. Update availability window
      await tx.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd)
        }
      });

      return {
        movedToExistingSlots: moveMapPartial.length,
        rescheduledToOtherSessions: rescheduled.length,
        addedToQueue: stillLeft.length
      };
    });

    // TODO: Send email notifications for rescheduled appointments

    return {
      message: 'Session shrunk successfully',
      strategy: 'OPTION_C',
      originalWindow: `${availability.consultingStartTime} - ${availability.consultingEndTime}`,
      newWindow: `${this.minutesToTime(newStart)} - ${this.minutesToTime(newEnd)}`,
      affectedAppointments: affectedAppointments.length,
      ...result,
      rescheduledDetails: rescheduled
    };
  }

  // ─── Helper: Distribute appointments into slots with available space ───
  private distributeToSlots(
    appointments: any[],
    slots: any[]
  ): { appointmentId: string; fromSlotId: string; toSlotId: string }[] {
    const moves: { appointmentId: string; fromSlotId: string; toSlotId: string }[] = [];
    let apptIndex = 0;

    for (const slot of slots) {
      if (apptIndex >= appointments.length) break;
      const freeSpots = slot.maxAppt - slot.appointments.length;
      for (let i = 0; i < freeSpots && apptIndex < appointments.length; i++) {
        moves.push({
          appointmentId: appointments[apptIndex].id,
          fromSlotId: appointments[apptIndex].slotId,
          toSlotId: slot.id
        });
        apptIndex++;
      }
    }
    return moves;
  }

  // ─── Apply basic shrink (Option A or no affected patients) ───
  private async applyShrink(
    availability: any,
    newStart: number,
    newEnd: number,
    slotDuration: number,
    removedSlots: any[],
    moveMap: { appointmentId: string; fromSlotId: string; toSlotId: string }[]
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Move appointments
      for (const move of moveMap) {
        await tx.appointment.update({
          where: { id: move.appointmentId },
          data: {
            slotId: move.toSlotId,
            originalSlotId: move.fromSlotId,
            isRescheduled: true
          }
        });
      }

      // Delete removed slots
      for (const slot of removedSlots) {
        await tx.availabilitySlot.delete({ where: { id: slot.id } });
      }

      // Deactivate elastic slots outside window
      await tx.elasticSlot.updateMany({
        where: {
          availabilityId: availability.id,
          OR: [
            { startTime: { lt: this.minutesToTime(newStart) } },
            { endTime: { gt: this.minutesToTime(newEnd) } },
          ]
        },
        data: { isActive: false }
      });

      // Update availability window
      await tx.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd)
        }
      });
    });

    const strategy = moveMap.length > 0 ? 'OPTION_A' : 'NO_AFFECTED';
    return {
      message: moveMap.length > 0
        ? `Session shrunk. ${moveMap.length} appointment(s) moved to available slots.`
        : 'Session shrunk successfully. No appointments were affected.',
      strategy,
      originalWindow: `${availability.consultingStartTime} - ${availability.consultingEndTime}`,
      newWindow: `${this.minutesToTime(newStart)} - ${this.minutesToTime(newEnd)}`,
      affectedAppointments: moveMap.length,
      movedToExistingSlots: moveMap.length,
      rescheduledToOtherSessions: 0,
      addedToQueue: 0
    };
  }

  // ─── Apply shrink with reduced slot duration (Option B) ───
  private async applyShrinkWithReducedDuration(
    availability: any,
    newStart: number,
    newEnd: number,
    newDuration: number,
    maxPerSlot: number,
    removedSlots: any[],
    keptSlots: any[],
    affectedAppointments: any[]
  ) {
    // Collect ALL active appointments (kept + affected)
    const allAppts: any[] = [];
    for (const s of keptSlots) {
      allAppts.push(...s.appointments);
    }
    allAppts.push(...affectedAppointments);

    // Generate new slot structure with reduced duration
    const newSlots: { startTime: string; endTime: string; maxAppt: number }[] = [];
    let cur = newStart;
    while (cur + newDuration <= newEnd) {
      newSlots.push({
        startTime: this.minutesToTime(cur),
        endTime: this.minutesToTime(cur + newDuration),
        maxAppt: maxPerSlot
      });
      cur += newDuration;
    }

    await this.prisma.$transaction(async (tx) => {
      // Delete ALL old slots for this availability (we're rebuilding)
      await tx.availabilitySlot.deleteMany({ where: { availabilityId: availability.id } });

      // Deactivate elastic slots
      await tx.elasticSlot.updateMany({
        where: { availabilityId: availability.id },
        data: { isActive: false }
      });

      // Create new slots
      const createdSlots = [];
      for (const ns of newSlots) {
        const created = await tx.availabilitySlot.create({
          data: {
            availabilityId: availability.id,
            startTime: ns.startTime,
            endTime: ns.endTime,
            maxAppt: ns.maxAppt
          }
        });
        createdSlots.push(created);
      }

      // Redistribute ALL appointments across new slots (earliest first)
      allAppts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      let slotIdx = 0;
      let filledInSlot = 0;

      for (const appt of allAppts) {
        if (slotIdx >= createdSlots.length) break;
        await tx.appointment.update({
          where: { id: appt.id },
          data: {
            slotId: createdSlots[slotIdx].id,
            originalSlotId: appt.slotId,
            isRescheduled: true
          }
        });
        filledInSlot++;
        if (filledInSlot >= maxPerSlot) {
          slotIdx++;
          filledInSlot = 0;
        }
      }

      // Update availability
      await tx.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd),
          slotDuration: newDuration,
          maxAppt: newSlots.reduce((sum, s) => sum + s.maxAppt, 0)
        }
      });
    });

    return {
      message: `Session shrunk. Slot duration reduced from ${availability.slotDuration} to ${newDuration} mins to accommodate all patients.`,
      strategy: 'OPTION_B',
      originalWindow: `${availability.consultingStartTime} - ${availability.consultingEndTime}`,
      newWindow: `${this.minutesToTime(newStart)} - ${this.minutesToTime(newEnd)}`,
      originalSlotDuration: availability.slotDuration,
      newSlotDuration: newDuration,
      affectedAppointments: affectedAppointments.length,
      totalPatients: allAppts.length,
      newSlotCount: newSlots.length,
      movedToExistingSlots: 0,
      rescheduledToOtherSessions: 0,
      addedToQueue: 0
    };
  }
}
