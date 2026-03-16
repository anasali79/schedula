import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExpandSessionDto, ShrinkSessionDto } from './dto/elastic.dto';
import { EmailService } from '../email/email.service';

@Injectable()
export class ElasticSchedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService
  ) { }

  private timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  private minutesToTime(minutes: number): string {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private to12Hour(time: string): string {
    const [h, m] = time.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
  }

  private calculateReportingTime(startTime: string, endTime: string, maxAppt: number, token: number): string {
    const start = this.timeToMinutes(startTime);
    const end = this.timeToMinutes(endTime);
    const duration = end - start;
    const offset = Math.floor(((token - 1) * duration) / maxAppt);
    const reportingMinutes = start + offset;
    return this.to12Hour(`${Math.floor(reportingMinutes / 60).toString().padStart(2, '0')}:${reportingMinutes % 60}`);
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
    const isStream = availability.scheduleType === 'STREAM';

    // ─── Special Case: STREAM (Always treat as a single block) ───
    if (isStream) {
      return this.handleStreamLongBatchExpand(doctor.id, availability, dto);
    }

    const interval = availability.slotDuration || 15;

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

  // ─── Handle STREAM Expand (Single large block) ───
  private async handleStreamLongBatchExpand(doctorId: string, availability: any, dto: ExpandSessionDto) {
    const singleSlot = availability.slots[0];
    const originalStart = this.timeToMinutes(availability.consultingStartTime);
    const originalEnd = this.timeToMinutes(availability.consultingEndTime);
    const newStart = dto.newStartTime ? this.timeToMinutes(dto.newStartTime) : originalStart;
    const newEnd = dto.newEndTime ? this.timeToMinutes(dto.newEndTime) : originalEnd;

    if (newStart > originalStart || newEnd < originalEnd) {
      throw new BadRequestException('Expand operation cannot shrink the session.');
    }

    const currentMax = availability.maxAppt || 0;
    const newMax = dto.newMaxPerSlot || currentMax;
    if (newMax < currentMax) throw new BadRequestException('Expand cannot reduce capacity.');

    await this.prisma.$transaction(async (tx) => {
      // 1. Update the single slot or create if missing
      if (singleSlot) {
        await tx.availabilitySlot.update({
          where: { id: singleSlot.id },
          data: {
            startTime: this.minutesToTime(newStart),
            endTime: this.minutesToTime(newEnd),
            maxAppt: newMax
          }
        });
      } else {
        await tx.availabilitySlot.create({
          data: {
            availabilityId: availability.id,
            startTime: this.minutesToTime(newStart),
            endTime: this.minutesToTime(newEnd),
            maxAppt: newMax
          }
        });
      }

      // 2. Update availability record
      await tx.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd),
          maxAppt: newMax
        }
      });
    });

    return {
      scheduleType: availability.scheduleType,
      message: 'Stream session expanded successfully',
      newWindow: `${this.minutesToTime(newStart)} - ${this.minutesToTime(newEnd)}`,
      newMaxAppt: newMax
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
          include: { 
            appointments: { 
              where: { status: 'CONFIRMED' },
              include: { patient: { include: { user: true } } }
            } 
          },
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

    const isWave = availability.scheduleType === 'WAVE';
    const isStream = availability.scheduleType === 'STREAM';
    const now = new Date();

    // ─── Special Case: STREAM (Always treat as a single block) ───
    if (isStream) {
      return this.handleStreamLongBatchShrink(availability, newStart, newEnd, originalStart, originalEnd);
    }

    // ─── Discrete Slot Logic (WAVE or STREAM with intervals) ───
    const slotDuration = availability.slotDuration || 15;
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
      const result = await this.applyShrink(availability, newStart, newEnd, slotDuration, removedSlots, []);
      return result;
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
      const result = await this.applyShrink(availability, newStart, newEnd, slotDuration, removedSlots, moveMap);
      
      // Trigger Emails
      this.triggerRescheduleEmails(moveMap, availability);
      
      return result;
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

      // Trigger Emails for everyone (since duration changed)
      this.triggerDurationChangeEmails(availability, newStart, newEnd, optimalDuration, maxPerSlot);

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
        addedToQueue: stillLeft.length,
        rescheduledDetails: rescheduled,
        stillLeftDetails: stillLeft
      };
    });

    // ─── Trigger Emails for Option C ───
    // 1. For Option A moves
    this.triggerRescheduleEmails(moveMapPartial, availability);
    
    // 2. For Option C (other sessions)
    this.triggerOtherSessionEmails(rescheduled, availability, doctor);

    // 3. For Queue
    this.triggerQueueEmails(stillLeft, availability, doctor);

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

    // Track state for each slot (existing count + patient uniqueness)
    const slotStates = slots.map(s => ({
      id: s.id,
      currentCount: s.appointments.length,
      maxAppt: s.maxAppt,
      patientDates: new Set(s.appointments.map((a: any) => `${a.patientId}_${a.appointmentDate.toISOString()}`))
    }));

    for (const appt of appointments) {
      const patientKey = `${appt.patientId}_${appt.appointmentDate.toISOString()}`;
      let assigned = false;

      for (const state of slotStates) {
        if (state.currentCount < state.maxAppt && !state.patientDates.has(patientKey)) {
          moves.push({
            appointmentId: appt.id,
            fromSlotId: appt.slotId,
            toSlotId: state.id
          });
          state.currentCount++;
          state.patientDates.add(patientKey);
          assigned = true;
          break;
        }
      }
      // Note: If an appt can't fit anywhere without violating unique constraint, 
      // it won't be in 'moves', which is handled by Option C fallback in the caller.
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
    const oldSlotIds = availability.slots.map((s: any) => s.id);

    await this.prisma.$transaction(async (tx) => {
      // 1. Fetch confirmed appointments inside transaction to ensure we have the latest state
      const confirmedAppts = await tx.appointment.findMany({
        where: {
          slotId: { in: oldSlotIds },
          status: 'CONFIRMED'
        },
        orderBy: { createdAt: 'asc' }
      });

      // 2. Deactivate elastic slots
      await tx.elasticSlot.updateMany({
        where: { availabilityId: availability.id },
        data: { isActive: false }
      });

      // 3. Create new slots
      const createdSlots = [];
      let cur = newStart;
      while (cur + newDuration <= newEnd) {
        const created = await tx.availabilitySlot.create({
          data: {
            availabilityId: availability.id,
            startTime: this.minutesToTime(cur),
            endTime: this.minutesToTime(cur + newDuration),
            maxAppt: maxPerSlot
          }
        });
        createdSlots.push(created);
        cur += newDuration;
      }

      // 4. Redistribute appointments
      const slotUsage = createdSlots.map(s => ({
        id: s.id,
        fillCount: 0,
        maxAppt: s.maxAppt,
        patientDates: new Set<string>()
      }));

      for (const appt of confirmedAppts) {
        const patientKey = `${appt.patientId}_${appt.appointmentDate.toISOString()}`;
        let assigned = false;

        for (const usage of slotUsage) {
          if (usage.fillCount < usage.maxAppt && !usage.patientDates.has(patientKey)) {
            await tx.appointment.update({
              where: { id: appt.id },
              data: {
                slotId: usage.id,
                originalSlotId: appt.slotId,
                isRescheduled: true
              }
            });
            usage.fillCount++;
            usage.patientDates.add(patientKey);
            assigned = true;
            break;
          }
        }

        if (!assigned) {
          // Failure fallback: Move to queue if they don't fit
          await tx.rescheduleQueue.create({
            data: {
              appointmentId: appt.id,
              reason: `Slot duration reduced. No space for patient ${appt.patientId} on ${appt.appointmentDate.toISOString()} without violating slot rules.`,
              priority: 2
            }
          });
        }
      }

      // 5. Delete old slots safely
      await tx.availabilitySlot.deleteMany({ 
        where: { id: { in: oldSlotIds } } 
      });

      // 6. Update availability record
      await tx.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd),
          slotDuration: newDuration,
          maxAppt: createdSlots.length * maxPerSlot
        }
      });
    });

    const newSlotCount = Math.floor((newEnd - newStart) / newDuration);

    return {
      message: `Session shrunk. Slot duration reduced from ${availability.slotDuration} to ${newDuration} mins to accommodate all patients.`,
      strategy: 'OPTION_B',
      originalWindow: `${availability.consultingStartTime} - ${availability.consultingEndTime}`,
      newWindow: `${this.minutesToTime(newStart)} - ${this.minutesToTime(newEnd)}`,
      originalSlotDuration: availability.slotDuration,
      newSlotDuration: newDuration,
      affectedAppointments: affectedAppointments.length,
      totalPatients: allAppts.length,
      newSlotCount: newSlotCount,
      movedToExistingSlots: 0,
      rescheduledToOtherSessions: 0,
      addedToQueue: 0
    };
  }

  // ─── Handle STREAM Long Batch Shrink (Single large slot) ───
  private async handleStreamLongBatchShrink(
    availability: any,
    newStart: number,
    newEnd: number,
    originalStart: number,
    originalEnd: number
  ) {
    const singleSlot = availability.slots[0];
    if (!singleSlot) {
      // No slot exists? Just update availability
      await this.prisma.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd)
        }
      });
      return { message: 'Session shrunk (no slots existed)', strategy: 'STREAM_EMPTY' };
    }

    const oldDuration = originalEnd - originalStart;
    const newDuration = newEnd - newStart;
    const currentMax = availability.maxAppt || 0;
    
    // Calculate new capacity proportionally (e.g., 2h -> 1h means 20 -> 10)
    const newMax = Math.max(1, Math.floor((newDuration / oldDuration) * currentMax));
    
    // Sort combined appointments by booking time (First Come First Serve)
    const allAppts = [...singleSlot.appointments].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    const keptAppts = allAppts.slice(0, newMax);
    const affectedAppts = allAppts.slice(newMax);

    await this.prisma.$transaction(async (tx) => {
      // 1. Update the single slot
      await tx.availabilitySlot.update({
        where: { id: singleSlot.id },
        data: {
          startTime: this.minutesToTime(newStart),
          endTime: this.minutesToTime(newEnd),
          maxAppt: newMax
        }
      });

      // 2. Move overflow to RescheduleQueue (FCFS)
      for (const appt of affectedAppts) {
        await tx.rescheduleQueue.create({
          data: {
            appointmentId: appt.id,
            reason: `Stream session shrunk. Capacity reduced from ${currentMax} to ${newMax}.`,
            priority: 1
          }
        });
        // Optional: mark appointment as needing attention
      }

      // 3. Update availability record
      await tx.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd),
          maxAppt: newMax
        }
      });
    });

    // ─── Trigger Emails ───
    this.triggerStreamInformativeEmails(keptAppts, availability, availability.doctor, newStart, newEnd, newMax);
    this.triggerQueueEmails(affectedAppts, availability, availability.doctor);

    return {
      message: `Stream session shrunk. Capacity automatically reduced to ${newMax} based on time reduction.`,
      strategy: 'STREAM_LONG_BATCH',
      originalWindow: `${availability.consultingStartTime} - ${availability.consultingEndTime}`,
      newWindow: `${this.minutesToTime(newStart)} - ${this.minutesToTime(newEnd)}`,
      originalMaxAppt: currentMax,
      newMaxAppt: newMax,
      affectedAppointments: affectedAppts.length,
      movedToQueue: affectedAppts.length
    };
  }

  // ─── Email Trigger Helpers ───

  private async triggerRescheduleEmails(moves: any[], availability: any) {
    const doctorName = `Dr. ${availability.doctor.firstName}${availability.doctor.lastName ? ' ' + availability.doctor.lastName : ''}`;
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const newDayName = DAY_NAMES[new Date(availability.date!).getUTCDay()];

    for (const move of moves) {
      const appt = await this.prisma.appointment.findUnique({
        where: { id: move.appointmentId },
        include: { patient: { include: { user: true } }, slot: true }
      });
      if (!appt) continue;

      const oldSlot = await this.prisma.availabilitySlot.findUnique({ where: { id: move.fromSlotId } });
      const oldTime = oldSlot ? `${this.to12Hour(oldSlot.startTime)} - ${this.to12Hour(oldSlot.endTime)}` : 'N/A';
      
      // Token calculation (simplified for now: order in slot)
      const token = await this.prisma.appointment.count({
        where: { slotId: move.toSlotId, appointmentDate: appt.appointmentDate, createdAt: { lt: appt.createdAt }, status: 'CONFIRMED' }
      }) + 1;

      const reportingTime = this.calculateReportingTime(appt.slot.startTime, appt.slot.endTime, appt.slot.maxAppt, token);

      this.emailService.sendAppointmentReschedule({
        to: appt.patient.user.email,
        patientName: `${appt.patient.firstName} ${appt.patient.lastName || ''}`,
        doctorName,
        oldDate: new Date(availability.date!).toISOString().split('T')[0],
        oldSlotTime: oldTime,
        newDate: new Date(availability.date!).toISOString().split('T')[0],
        newDay: newDayName,
        newSlotTime: `${this.to12Hour(appt.slot.startTime)} to ${this.to12Hour(appt.slot.endTime)}`,
        newReportingTime: reportingTime,
        token,
        rescheduledBy: 'Doctor'
      });
    }
  }

  private async triggerDurationChangeEmails(availability: any, newStart: number, newEnd: number, newDuration: number, maxPerSlot: number) {
    const appts = await this.prisma.appointment.findMany({
      where: { 
        slot: { availabilityId: availability.id },
        appointmentDate: availability.date,
        status: 'CONFIRMED'
      },
      include: { patient: { include: { user: true } }, slot: true },
      orderBy: { createdAt: 'asc' }
    });

    const doctorName = `Dr. ${availability.doctor.firstName}${availability.doctor.lastName ? ' ' + availability.doctor.lastName : ''}`;
    const dateStr = new Date(availability.date!).toISOString().split('T')[0];

    for (const appt of appts) {
      // Logic for new token and time is handled by the redistribution in Option B
      // Here we just notify them of their NEW actual assigned slot and reporting time
      const token = await this.prisma.appointment.count({
        where: { slotId: appt.slotId, appointmentDate: appt.appointmentDate, createdAt: { lt: appt.createdAt }, status: 'CONFIRMED' }
      }) + 1;

      const reportingTime = this.calculateReportingTime(appt.slot.startTime, appt.slot.endTime, appt.slot.maxAppt, token);

      this.emailService.sendAppointmentReschedule({
        to: appt.patient.user.email,
        patientName: `${appt.patient.firstName} ${appt.patient.lastName || ''}`,
        doctorName,
        oldDate: dateStr,
        oldSlotTime: 'Original Time',
        newDate: dateStr,
        newDay: new Date(availability.date!).toLocaleDateString('en-US', { weekday: 'long' }),
        newSlotTime: `${this.to12Hour(appt.slot.startTime)} to ${this.to12Hour(appt.slot.endTime)}`,
        newReportingTime: reportingTime,
        token,
        rescheduledBy: 'Doctor'
      });
    }
  }

  private async triggerQueueEmails(appts: any[], availability: any, doctor: any) {
    const doctorName = `Dr. ${doctor.firstName} ${doctor.lastName || ''}`;
    const dateStr = new Date(availability.date!).toISOString().split('T')[0];

    for (const appt of appts) {
      const fullAppt = await this.prisma.appointment.findUnique({
        where: { id: appt.id },
        include: { patient: { include: { user: true } }, slot: true }
      });
      if (!fullAppt) continue;

      this.emailService.sendAppointmentMovedToQueue({
        to: fullAppt.patient.user.email,
        patientName: `${fullAppt.patient.firstName} ${fullAppt.patient.lastName || ''}`,
        doctorName,
        date: dateStr,
        oldSlotTime: `${this.to12Hour(fullAppt.slot.startTime)} - ${this.to12Hour(fullAppt.slot.endTime)}`,
        reason: `Session window shrunk to ${this.minutesToTime(this.timeToMinutes(availability.consultingStartTime))}-${this.minutesToTime(this.timeToMinutes(availability.consultingEndTime))}.`
      });
    }
  }

  private async triggerOtherSessionEmails(moves: any[], availability: any, doctor: any) {
    const doctorName = `Dr. ${doctor.firstName} ${doctor.lastName || ''}`;
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (const move of moves) {
      const appt = await this.prisma.appointment.findUnique({
        where: { id: move.appointmentId },
        include: { patient: { include: { user: true } }, slot: { include: { availability: true } } }
      });
      if (!appt) continue;

      const newDate = new Date(appt.slot.availability.date!);
      const newDateStr = newDate.toISOString().split('T')[0];
      const newDay = DAY_NAMES[newDate.getUTCDay()];

      this.emailService.sendAppointmentReschedule({
        to: appt.patient.user.email,
        patientName: `${appt.patient.firstName} ${appt.patient.lastName || ''}`,
        doctorName,
        oldDate: new Date(availability.date!).toISOString().split('T')[0],
        oldSlotTime: 'Original Preference',
        newDate: newDateStr,
        newDay,
        newSlotTime: `${this.to12Hour(appt.slot.startTime)} to ${this.to12Hour(appt.slot.endTime)}`,
        newReportingTime: this.calculateReportingTime(appt.slot.startTime, appt.slot.endTime, appt.slot.maxAppt, 1), // Assuming token 1 for now or calculate actual
        token: 1, 
        rescheduledBy: 'Doctor'
      });
    }
  }

  private async triggerStreamInformativeEmails(appts: any[], availability: any, doctor: any, newStart: number, newEnd: number, maxAppt: number) {
    const doctorName = `Dr. ${doctor.firstName} ${doctor.lastName || ''}`;
    const dateStr = new Date(availability.date!).toISOString().split('T')[0];
    const newStartStr = this.minutesToTime(newStart);
    const newEndStr = this.minutesToTime(newEnd);
    const newWindow = `${this.to12Hour(newStartStr)} - ${this.to12Hour(newEndStr)}`;

    for (const appt of appts) {
      // Calculate new reporting time for Stream (staggered)
      const token = await this.prisma.appointment.count({
        where: { slotId: appt.slotId, appointmentDate: appt.appointmentDate, createdAt: { lt: appt.createdAt }, status: 'CONFIRMED' }
      }) + 1;

      const reportingTime = this.calculateReportingTime(newStartStr, newEndStr, maxAppt, token);

      this.emailService.sendInformativeEmail(
        appt.patient.user.email,
        'Updated Session Timing - Schedula',
        'Session Schedule Update',
        `<p>Hi ${appt.patient.firstName}, please note that your session with <strong>${doctorName}</strong> on <strong>${dateStr}</strong> now has updated timings: <strong>${newWindow}</strong>.</p>
         <p>Your new reporting time is <strong>${reportingTime}</strong> (Token #${token}). Please arrive accordingly.</p>
         <p>Your appointment is still confirmed.</p>`
      );
    }
  }
}
