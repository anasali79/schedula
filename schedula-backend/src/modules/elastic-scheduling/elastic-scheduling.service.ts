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
      include: { slots: true, doctor: true }
    });

    if (!availability) throw new NotFoundException('Availability block not found');
    if (availability.doctorId !== doctor.id) throw new BadRequestException('Not authorized to modify this session');

    // ─── Special Case: Auto-convert template to custom if sessionDate provided ───
    const effectiveAvailability = await this.ensureCustomAvailability(availability, dto.sessionDate);
    const isWave = effectiveAvailability.scheduleType === 'WAVE';
    const isStream = effectiveAvailability.scheduleType === 'STREAM';

    // ─── Special Case: STREAM (Always treat as a single block) ───
    if (isStream) {
      return this.handleStreamLongBatchExpand(doctor.id, effectiveAvailability, dto);
    }

    const interval = effectiveAvailability.slotDuration || 15;

    const originalStartMin = this.timeToMinutes(effectiveAvailability.consultingStartTime);
    const originalEndMin = this.timeToMinutes(effectiveAvailability.consultingEndTime);
    const newStartMin = dto.newStartTime ? this.timeToMinutes(dto.newStartTime) : originalStartMin;
    const newEndMin = dto.newEndTime ? this.timeToMinutes(dto.newEndTime) : originalEndMin;

    if (newStartMin > originalStartMin || newEndMin < originalEndMin) {
      throw new BadRequestException('Expand operation cannot shrink the session.');
    }

    const currentMax = effectiveAvailability.slots[0]?.maxAppt || 0;
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
      for (const slot of effectiveAvailability.slots) {
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
            availabilityId: effectiveAvailability.id,
            sessionDate: effectiveAvailability.date!,
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
      where: { id: effectiveAvailability.id },
      data: {
        consultingStartTime: this.minutesToTime(newStartMin),
        consultingEndTime: this.minutesToTime(newEndMin)
      }
    });

    return {
      scheduleType: effectiveAvailability.scheduleType,
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
        doctor: true,
        slots: {
          include: {
            appointments: {
              include: { patient: { include: { user: true } } }
            }
          },
          orderBy: { startTime: 'asc' as const }
        }
      }
    });

    if (!availability) throw new NotFoundException('Availability block not found');
    if (availability.doctorId !== doctor.id) throw new BadRequestException('Not authorized');

    // ─── Special Case: Auto-convert template to custom if sessionDate provided ───
    const effectiveAvailability = await this.ensureCustomAvailability(availability, dto.sessionDate);

    const originalStart = this.timeToMinutes(effectiveAvailability.consultingStartTime);
    const originalEnd = this.timeToMinutes(effectiveAvailability.consultingEndTime);
    const newStart = dto.newStartTime ? this.timeToMinutes(dto.newStartTime) : originalStart;
    const newEnd = dto.newEndTime ? this.timeToMinutes(dto.newEndTime) : originalEnd;

    if (newStart < originalStart || newEnd > originalEnd) {
      throw new BadRequestException('Shrink cannot expand the session.');
    }
    if (newStart >= newEnd) {
      throw new BadRequestException('New start must be before new end.');
    }

    const isWave = effectiveAvailability.scheduleType === 'WAVE';
    const isStream = effectiveAvailability.scheduleType === 'STREAM';
    const now = new Date();

    // ─── Special Case: STREAM (Always treat as a single block) ───
    if (isStream) {
      return this.handleStreamLongBatchShrink(effectiveAvailability, newStart, newEnd, originalStart, originalEnd);
    }

    // ─── Discrete Slot Logic (WAVE or STREAM with intervals) ───
    const slotDuration = effectiveAvailability.slotDuration || 15;
    const keptSlots: typeof effectiveAvailability.slots = [];
    const historySlots: typeof effectiveAvailability.slots = [];
    const removableSlots: typeof effectiveAvailability.slots = [];
    const affectedAppointments: any[] = [];

    for (const slot of effectiveAvailability.slots) {
      const sStart = this.timeToMinutes(slot.startTime);
      const sEnd = this.timeToMinutes(slot.endTime);
      const isInside = sStart >= newStart && sEnd <= newEnd;

      if (isInside) {
        keptSlots.push(slot);
      } else {
        // Outside the new window
        const hasHistory = slot.appointments.some((a: any) =>
          a.status === 'COMPLETED' ||
          a.status === 'CANCELLED' ||
          a.checkedInAt !== null
        );

        if (hasHistory) {
          // Keep for record, but it won't be in 'keptSlots' (so no new bookings)
          historySlots.push(slot);

          // If there are still CONFIRMED (not checked-in) appts in this history slot, move them
          const unCheckedConfirmations = slot.appointments.filter((a: any) => a.status === 'CONFIRMED' && !a.checkedInAt);
          affectedAppointments.push(...unCheckedConfirmations);
        } else {
          removableSlots.push(slot);
          // Only CONFIRMED appts will be here anyway since hasHistory is false
          affectedAppointments.push(...slot.appointments.filter((a: any) => a.status === 'CONFIRMED'));
        }
      }
    }

    // No affected patients → just shrink
    if (affectedAppointments.length === 0) {
      const result = await this.applyShrink(effectiveAvailability, newStart, newEnd, slotDuration, removableSlots, []);
      return result;
    }

    // ─── OPTION A: Fit into remaining future kept slots ───
    // Only consider FUTURE kept slots (doctor hasn't consulted them yet)
    const futureKeptSlots = keptSlots.filter((s: any) => {
      // A slot is "future" if its start time hasn't passed yet
      const slotDateTime = new Date(effectiveAvailability.date!);
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
      const result = await this.applyShrink(effectiveAvailability, newStart, newEnd, slotDuration, removableSlots, moveMap);

      // Trigger Emails
      this.triggerRescheduleEmails(moveMap, effectiveAvailability);

      return result;
    }

    // ─── OPTION B: Reduce slot duration to create more capacity ───
    const windowMinutes = newEnd - newStart;
    const totalPatientsNeeded = futureKeptSlots.reduce((sum: number, s: any) => sum + s.appointments.length, 0) + affectedAppointments.length;

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
        effectiveAvailability, newStart, newEnd, optimalDuration, maxPerSlot,
        removableSlots, keptSlots, affectedAppointments
      );

      // Trigger Emails for everyone (since duration changed)
      this.triggerDurationChangeEmails(effectiveAvailability, newStart, newEnd, optimalDuration, maxPerSlot);

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
        date: effectiveAvailability.date!,
        id: { not: effectiveAvailability.id },
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
          date: { gt: effectiveAvailability.date! },
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
        await tx.slotAllocation.deleteMany({ where: { appointmentId: move.appointmentId } });
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
        await tx.slotAllocation.deleteMany({ where: { appointmentId: move.appointmentId } });
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
        await tx.slotAllocation.deleteMany({ where: { appointmentId: appt.id } });
        await tx.rescheduleQueue.create({
          data: {
            appointmentId: appt.id,
            reason: `Session shrunk from ${effectiveAvailability.consultingStartTime}-${effectiveAvailability.consultingEndTime} to ${this.minutesToTime(newStart)}-${this.minutesToTime(newEnd)}. No available slot found.`,
            priority: 1
          }
        });
      }

      // 4. Delete removable slots (only those with NO history)
      for (const slot of removableSlots) {
        await tx.availabilitySlot.delete({ where: { id: slot.id } });
      }

      // 5. Deactivate related elastic slots outside window
      await tx.elasticSlot.updateMany({
        where: {
          availabilityId: effectiveAvailability.id,
          OR: [
            { startTime: { lt: this.minutesToTime(newStart) } },
            { endTime: { gt: this.minutesToTime(newEnd) } },
          ]
        },
        data: { isActive: false }
      });

      // 6. Update availability window
      await tx.availability.update({
        where: { id: effectiveAvailability.id },
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
    this.triggerRescheduleEmails(moveMapPartial, effectiveAvailability);

    // 2. For Option C (other sessions)
    this.triggerOtherSessionEmails(rescheduled, effectiveAvailability, doctor);


    this.triggerQueueEmails(stillLeft, effectiveAvailability, doctor);

    return {
      message: 'Session shrunk successfully',
      strategy: 'OPTION_C',
      originalWindow: `${effectiveAvailability.consultingStartTime} - ${effectiveAvailability.consultingEndTime}`,
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
        await tx.slotAllocation.deleteMany({ where: { appointmentId: move.appointmentId } });
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
    const allAppts: any[] = [];
    for (const s of keptSlots) {
      allAppts.push(...s.appointments);
    }
    allAppts.push(...affectedAppointments);

    let createdSlots: any[] = [];
    let historySlotIds: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      // 1. Identify slots that MUST stay (History) from ALL slots of the session
      historySlotIds = (availability.slots || []).filter((s: any) =>
        s.appointments.some((a: any) => a.status === 'COMPLETED' || a.status === 'CANCELLED' || a.checkedInAt !== null)
      ).map((s: any) => s.id);

      const removableSlotIds = (availability.slots || [])
        .filter((s: any) => !historySlotIds.includes(s.id))
        .map((s: any) => s.id);

      // 2. Fetch all appointments that need a home (CONFIRMED and not checked-in)
      const confirmedAppts = await tx.appointment.findMany({
        where: {
          slotId: { in: availability.slots.map((s: any) => s.id) },
          status: 'CONFIRMED',
          checkedInAt: null
        },
        orderBy: { createdAt: 'asc' }
      });

      // 3. Deactivate elastic slots
      await tx.elasticSlot.updateMany({
        where: { availabilityId: availability.id },
        data: { isActive: false }
      });

      // 4. Create new slots only in the "Free" space
      let cur = newStart;
      while (cur + newDuration <= newEnd) {
        // Check if this time overlaps with any history slot
        const overlapsHistory = availability.slots.some((s: any) => {
          if (!historySlotIds.includes(s.id)) return false;
          const sMin = this.timeToMinutes(s.startTime);
          const eMin = this.timeToMinutes(s.endTime);
          return (cur >= sMin && cur < eMin);
        });

        if (!overlapsHistory) {
          const created = await tx.availabilitySlot.create({
            data: {
              availabilityId: availability.id,
              startTime: this.minutesToTime(cur),
              endTime: this.minutesToTime(cur + newDuration),
              maxAppt: maxPerSlot
            }
          });
          createdSlots.push(created);
        }
        cur += newDuration;
      }

      // 5. Redistribute appointments
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
            await tx.slotAllocation.deleteMany({ where: { appointmentId: appt.id } });
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
          await tx.slotAllocation.deleteMany({ where: { appointmentId: appt.id } });
          await tx.rescheduleQueue.create({
            data: {
              appointmentId: appt.id,
              reason: `Slot duration reduced. No space for patient ${appt.patientId} on ${appt.appointmentDate.toISOString()} without violating slot rules.`,
              priority: 2
            }
          });
        }
      }

      // 6. Delete only removable slots safely
      await tx.availabilitySlot.deleteMany({
        where: { id: { in: removableSlotIds } }
      });

      // 7. Update availability record
      await tx.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd),
          slotDuration: newDuration,
          maxAppt: (createdSlots.length + historySlotIds.length) * maxPerSlot
        }
      });
    });

    return {
      message: `Session shrunk. Slot duration reduced to ${newDuration} mins. ${allAppts.length} patients preserved.`,
      strategy: 'OPTION_B',
      originalWindow: `${availability.consultingStartTime} - ${availability.consultingEndTime}`,
      newWindow: `${this.minutesToTime(newStart)} - ${this.minutesToTime(newEnd)}`,
      newSlotDuration: newDuration,
      affectedAppointments: affectedAppointments.length,
      totalPatients: allAppts.length,
      newSlotCount: (createdSlots.length + historySlotIds.length),
      movedToExistingSlots: 0,
      rescheduledToOtherSessions: 0,
      addedToQueue: 0
    };
  }


  private async handleStreamLongBatchShrink(
    availability: any,
    newStart: number,
    newEnd: number,
    originalStart: number,
    originalEnd: number
  ) {
    const singleSlot = availability.slots[0];
    if (!singleSlot) {
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

    const newMax = Math.max(1, Math.floor((newDuration / oldDuration) * currentMax));

    const allAppts = [...singleSlot.appointments].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    const keptAppts = allAppts.slice(0, newMax);
    const affectedAppts = allAppts.filter(a => !keptAppts.map(k => k.id).includes(a.id));

    const movableToQueue = affectedAppts.filter(a => a.status === 'CONFIRMED' && !a.checkedInAt);
    const mustStay = affectedAppts.filter(a => a.status === 'COMPLETED' || a.checkedInAt);

    const finalMax = Math.max(newMax, keptAppts.length + mustStay.length);

    await this.prisma.$transaction(async (tx) => {
      await tx.availabilitySlot.update({
        where: { id: singleSlot.id },
        data: {
          startTime: this.minutesToTime(newStart),
          endTime: this.minutesToTime(newEnd),
          maxAppt: finalMax
        }
      });

      for (const appt of movableToQueue) {
        await tx.slotAllocation.deleteMany({ where: { appointmentId: appt.id } });
        await tx.rescheduleQueue.create({
          data: {
            appointmentId: appt.id,
            reason: `Stream session shrunk. Capacity reduced.`,
            priority: 1
          }
        });
      }

      await tx.availability.update({
        where: { id: availability.id },
        data: {
          consultingStartTime: this.minutesToTime(newStart),
          consultingEndTime: this.minutesToTime(newEnd),
          maxAppt: finalMax
        }
      });
    });

    this.triggerStreamInformativeEmails(keptAppts, availability, availability.doctor, newStart, newEnd, finalMax);
    this.triggerQueueEmails(movableToQueue, availability, availability.doctor);

    return {
      message: `Stream session shrunk. Capacity automatically reduced to ${finalMax} based on time reduction.`,
      strategy: 'STREAM_LONG_BATCH',
      originalWindow: `${availability.consultingStartTime} - ${availability.consultingEndTime}`,
      newWindow: `${this.minutesToTime(newStart)} - ${this.minutesToTime(newEnd)}`,
      originalMaxAppt: currentMax,
      newMaxAppt: finalMax,
      affectedAppointments: movableToQueue.length,
      movedToQueue: movableToQueue.length
    };
  }

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

      const token = await this.prisma.appointment.count({
        where: { slotId: appt.slot.id, appointmentDate: appt.appointmentDate, createdAt: { lt: appt.createdAt }, status: 'CONFIRMED' }
      }) + 1;

      this.emailService.sendAppointmentReschedule({
        to: appt.patient.user.email,
        patientName: `${appt.patient.firstName} ${appt.patient.lastName || ''}`,
        doctorName,
        oldDate: new Date(availability.date!).toISOString().split('T')[0],
        oldSlotTime: 'Original Preference',
        newDate: newDateStr,
        newDay,
        newSlotTime: `${this.to12Hour(appt.slot.startTime)} to ${this.to12Hour(appt.slot.endTime)}`,
        newReportingTime: this.calculateReportingTime(appt.slot.startTime, appt.slot.endTime, appt.slot.maxAppt, token),
        token,
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

  // ─── Helper: Ensure Custom Availability ───
  private async ensureCustomAvailability(availability: any, sessionDate?: string): Promise<any> {
    if (availability.date) return availability; // Already custom

    if (!sessionDate) {
      throw new BadRequestException('Cannot modify recurring template directly. Please provide sessionDate to convert it for a specific day.');
    }

    const date = new Date(sessionDate);
    date.setUTCHours(0, 0, 0, 0);

    // 1. Check if custom version already exists
    const existing = await this.prisma.availability.findFirst({
      where: {
        doctorId: availability.doctorId,
        date: date,
        session: availability.session // Using session to find matching template-based block
      },
      include: {
        doctor: true,
        slots: {
          include: { appointments: { include: { patient: { include: { user: true } } } } },
          orderBy: { startTime: 'asc' }
        }
      }
    });

    if (existing) return existing;

    // 2. Clone template into custom
    return await this.prisma.$transaction(async (tx) => {
      const custom = await tx.availability.create({
        data: {
          doctorId: availability.doctorId,
          date: date,
          scheduleType: availability.scheduleType,
          consultingStartTime: availability.consultingStartTime,
          consultingEndTime: availability.consultingEndTime,
          slotDuration: availability.slotDuration,
          maxAppt: availability.maxAppt,
          session: availability.session, // Link to template name
          dayOfWeek: null // Not recurring
        }
      });

      const slotMap = new Map(); // oldId -> newId

      for (const slot of availability.slots) {
        const newSlot = await tx.availabilitySlot.create({
          data: {
            availabilityId: custom.id,
            startTime: slot.startTime,
            endTime: slot.endTime,
            maxAppt: slot.maxAppt
          }
        });
        slotMap.set(slot.id, newSlot.id);
      }

      // 3. Re-link existing appointments for this specific date to new slots
      const appts = await tx.appointment.findMany({
        where: {
          slotId: { in: availability.slots.map((s: any) => s.id) },
          appointmentDate: date
        }
      });

      for (const appt of appts) {
        await tx.appointment.update({
          where: { id: appt.id },
          data: { slotId: slotMap.get(appt.slotId) }
        });
      }

      // Return newly created availability with full include
      return await tx.availability.findUnique({
        where: { id: custom.id },
        include: {
          doctor: true,
          slots: {
            include: { appointments: { include: { patient: { include: { user: true } } } } },
            orderBy: { startTime: 'asc' }
          }
        }
      });
    });
  }
}
