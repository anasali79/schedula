import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Availability, AvailabilitySlot } from '@prisma/client';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateSpecializationDto } from './dto/create-specialization.dto';
import {
  SetDaySlotsDto,
  SetWeekAvailabilityDto,
  AvailabilityConfigDto,
  SetCustomAvailabilityDto,
} from './dto/set-availability.dto';

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];


@Injectable()
export class DoctorsService {
  constructor(private readonly prisma: PrismaService) { } // Prisma client initialized here

  // "monday" → 1, "tuesday" → 2, etc.
  private dayNameToNumber(day: string): number {
    const index = DAY_NAMES.indexOf(day.toLowerCase());
    if (index === -1) {
      throw new BadRequestException(
        `Invalid day: "${day}". Use: sunday, monday, tuesday, wednesday, thursday, friday, saturday`,
      );
    }
    return index;
  }

  private capitalize(day: string): string {
    return day.charAt(0).toUpperCase() + day.slice(1).toLowerCase();
  }

  private async getDoctorByUserId(userId: string) {
    const doctor = await this.prisma.doctor.findUnique({
      where: { userId },
      include: {
        profile: true,
        specializations: true,

      },
    });
    if (!doctor) {
      throw new NotFoundException(
        'Doctor profile not found. Please complete doctor onboarding first.',
      );
    }
    return doctor;
  }

  async getMyProfile(userId: string) {
    const doctor = await this.getDoctorByUserId(userId);
    return doctor;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const doctor = await this.getDoctorByUserId(userId);

    const [updatedDoctor, updatedProfile] = await this.prisma.$transaction([
      this.prisma.doctor.update({
        where: { id: doctor.id },
        data: {
          ...(dto.firstName !== undefined && { firstName: dto.firstName }),
          ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        },
      }),
      doctor.profile
        ? this.prisma.profile.update({
          where: { doctorId: doctor.id },
          data: {
            ...(dto.bio !== undefined && { bio: dto.bio }),
            ...(dto.experienceYears !== undefined && {
              experienceYears: dto.experienceYears,
            }),
            ...(dto.consultationFee !== undefined && {
              consultationFee: dto.consultationFee,
            }),
          },
        })
        : this.prisma.profile.create({
          data: {
            doctorId: doctor.id,
            bio: dto.bio,
            experienceYears: dto.experienceYears,
            consultationFee: dto.consultationFee,
          },
        }),
    ]);

    return { ...updatedDoctor, profile: updatedProfile };
  }

  async addSpecialization(userId: string, dto: CreateSpecializationDto) {
    const doctor = await this.getDoctorByUserId(userId);
    const specialization = await this.prisma.specialization.create({
      data: {
        doctorId: doctor.id,
        name: dto.name,
      },
    });
    return specialization;
  }

  private timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  private to12Hour(time: string): string {
    const [h, m] = time.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
  }

  private generateWaveSlots(startMinutes: number, endMinutes: number, duration: number, maxApptPerSlot: number) {
    const units: { startTime: string; endTime: string; maxAppt: number }[] = [];
    let current = startMinutes;

    while (current < endMinutes) {
      const next = current + duration;
      if (next > endMinutes) break;

      units.push({
        startTime: this.minutesToTime(current),
        endTime: this.minutesToTime(next),
        maxAppt: maxApptPerSlot,
      });
      current = next;
    }
    return units;
  }


  private generateStreamBatches(startMinutes: number, endMinutes: number, interval: number, batchSize: number) {
    const batches: { startTime: string; endTime: string; maxAppt: number }[] = [];
    let current = startMinutes;

    while (current < endMinutes) {
      const next = current + interval;
      if (next > endMinutes) break;

      batches.push({
        startTime: this.minutesToTime(current),
        endTime: this.minutesToTime(next),
        maxAppt: batchSize,
      });
      current = next;
    }
    return batches;
  }

  private minutesToTime(minutes: number): string {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private validateAvailabilities(availabilities: AvailabilityConfigDto[]) {
    for (const config of availabilities) {
      const start = this.timeToMinutes(config.consultingStartTime);
      const end = this.timeToMinutes(config.consultingEndTime);
      if (end <= start) {
        throw new BadRequestException(
          `Invalid availability: consultingEndTime (${config.consultingEndTime}) must be after consultingStartTime (${config.consultingStartTime})`,
        );
      }

      const diff = end - start;

      if (config.scheduleType === 'STREAM') {
        if (!config.maxAppt) throw new BadRequestException('maxAppt is required for STREAM scheduling');
        if (config.streamInterval) {
          if (diff % config.streamInterval !== 0) {
            throw new BadRequestException(`streamInterval (${config.streamInterval} min) must perfectly divide the time range (${diff} min)`);
          }
          if (!config.streamBatchSize) throw new BadRequestException('streamBatchSize is required when streamInterval is provided');
        }
      } else if (config.scheduleType === 'WAVE') {
        if (!config.slotDuration) throw new BadRequestException('slotDuration is required for WAVE scheduling');
        if (!config.maxAppt) throw new BadRequestException('maxAppt (Slot Capacity) is required for WAVE scheduling');
        if (diff % config.slotDuration !== 0) {
          throw new BadRequestException(`slotDuration (${config.slotDuration} min) must perfectly divide the time range (${diff} min)`);
        }
      }
    }

    const sorted = [...availabilities].sort(
      (a, b) => this.timeToMinutes(a.consultingStartTime) - this.timeToMinutes(b.consultingStartTime),
    );

    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = this.timeToMinutes(sorted[i - 1].consultingEndTime);
      const currStart = this.timeToMinutes(sorted[i].consultingStartTime);
      if (currStart < prevEnd) {
        throw new BadRequestException(
          `Overlapping availabilities detected: ${sorted[i - 1].consultingStartTime}-${sorted[i - 1].consultingEndTime} overlaps with ${sorted[i].consultingStartTime}-${sorted[i].consultingEndTime}`,
        );
      }
    }
  }

  // PUT /api/v1/doctors/availability/monday
  async setDayAvailability(userId: string, day: string, dto: SetDaySlotsDto) {
    const doctor = await this.getDoctorByUserId(userId);
    const dayOfWeek = this.dayNameToNumber(day);

    this.validateAvailabilities(dto.availabilities);

    let isUpdate = false;

    // Using transaction for safe delete+recreate cascade
    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.availability.deleteMany({
        where: { doctorId: doctor.id, dayOfWeek },
      });
      if (deleted.count > 0) isUpdate = true;

      for (const config of dto.availabilities) {
        const start = this.timeToMinutes(config.consultingStartTime);
        const end = this.timeToMinutes(config.consultingEndTime);

        const isWave = config.scheduleType === 'WAVE';
        const units = isWave
          ? this.generateWaveSlots(start, end, config.slotDuration!, config.maxAppt!)
          : config.streamInterval
            ? this.generateStreamBatches(start, end, config.streamInterval!, config.streamBatchSize!)
            : [{ startTime: config.consultingStartTime, endTime: config.consultingEndTime, maxAppt: config.maxAppt! }];

        const totalMaxAppt = isWave
          ? config.maxAppt!
          : config.streamInterval
            ? units.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
            : config.maxAppt!;

        await tx.availability.create({
          data: {
            doctorId: doctor.id,
            dayOfWeek,
            scheduleType: config.scheduleType,
            consultingStartTime: config.consultingStartTime,
            consultingEndTime: config.consultingEndTime,
            maxAppt: totalMaxAppt,
            session: config.session || null,
            slotDuration: isWave ? config.slotDuration : null,
            streamInterval: config.scheduleType === 'STREAM' ? config.streamInterval : null,
            streamBatchSize: config.scheduleType === 'STREAM' ? config.streamBatchSize : null,
            slots: { create: units },
          },
        });
      }
    });

    const scheduleData = await this.getMyAvailability(userId);
    return {
      message: `Availability ${isUpdate ? 'updated' : 'created'} successfully for ${this.capitalize(day)}`,
      schedule: scheduleData.schedule
    };
  }

  // PUT /api/v1/doctors/availability (week)
  async setWeekAvailability(userId: string, dto: SetWeekAvailabilityDto) {
    const doctor = await this.getDoctorByUserId(userId);

    for (const daySchedule of dto.schedule) {
      this.dayNameToNumber(daySchedule.day); // validate day name
      this.validateAvailabilities(daySchedule.availabilities);
    }

    const daysToUpdate = dto.schedule.map((d) => this.dayNameToNumber(d.day));

    let isUpdate = false;

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.availability.deleteMany({
        where: {
          doctorId: doctor.id,
          dayOfWeek: { in: daysToUpdate },
        },
      });
      if (deleted.count > 0) isUpdate = true;

      for (const daySchedule of dto.schedule) {
        const dayOfWeek = this.dayNameToNumber(daySchedule.day);
        for (const config of daySchedule.availabilities) {
          const start = this.timeToMinutes(config.consultingStartTime);
          const end = this.timeToMinutes(config.consultingEndTime);

          const isWave = config.scheduleType === 'WAVE';
          const units = isWave
            ? this.generateWaveSlots(start, end, config.slotDuration!, config.maxAppt!)
            : config.streamInterval
              ? this.generateStreamBatches(start, end, config.streamInterval!, config.streamBatchSize!)
              : [{ startTime: config.consultingStartTime, endTime: config.consultingEndTime, maxAppt: config.maxAppt! }];

          const totalMaxAppt = isWave
            ? config.maxAppt!
            : config.streamInterval
              ? units.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
              : config.maxAppt!;

          await tx.availability.create({
            data: {
              doctorId: doctor.id,
              dayOfWeek,
              scheduleType: config.scheduleType,
              consultingStartTime: config.consultingStartTime,
              consultingEndTime: config.consultingEndTime,
              maxAppt: totalMaxAppt,
              session: config.session || null,
              slotDuration: isWave ? config.slotDuration : null,
              streamInterval: config.scheduleType === 'STREAM' ? config.streamInterval : null,
              streamBatchSize: config.scheduleType === 'STREAM' ? config.streamBatchSize : null,
              slots: { create: units },
            },
          });
        }
      }
    });

    const scheduleData = await this.getMyAvailability(userId);
    return {
      message: `Weekly availability ${isUpdate ? 'updated' : 'created'} successfully`,
      schedule: scheduleData.schedule
    };
  }

  // POST /api/v1/doctors/custom-availability/:date
  async setCustomAvailability(userId: string, dateStr: string, dto: SetCustomAvailabilityDto) {
    const doctor = await this.getDoctorByUserId(userId);
    const targetDate = new Date(dateStr);
    if (isNaN(targetDate.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const checkDate = new Date(targetDate);
    checkDate.setHours(0, 0, 0, 0);

    if (checkDate < today) {
      throw new BadRequestException('Cannot set availability for past dates');
    }

    const currentYear = today.getFullYear();
    if (checkDate.getFullYear() > currentYear) {
      throw new BadRequestException(`Cannot set availability for future years. Please stay within ${currentYear}`);
    }

    const dayOfWeek = targetDate.getDay();
    this.validateAvailabilities(dto.availabilities);

    let isUpdate = false;

    await this.prisma.$transaction(async (tx) => {
      // 1. Delete existing custom availability for this specific date
      const deletedCustom = await tx.availability.deleteMany({
        where: { doctorId: doctor.id, date: targetDate },
      });

      // 2. Delete existing recurring availability for this day of the week (SYNC LOGIC)
      await tx.availability.deleteMany({
        where: { doctorId: doctor.id, dayOfWeek: dayOfWeek, date: null },
      });

      if (deletedCustom.count > 0) isUpdate = true;

      for (const config of dto.availabilities) {
        const start = this.timeToMinutes(config.consultingStartTime);
        const end = this.timeToMinutes(config.consultingEndTime);

        const isWave = config.scheduleType === 'WAVE';
        const units = isWave
          ? this.generateWaveSlots(start, end, config.slotDuration!, config.maxAppt!)
          : config.streamInterval
            ? this.generateStreamBatches(start, end, config.streamInterval!, config.streamBatchSize!)
            : [{ startTime: config.consultingStartTime, endTime: config.consultingEndTime, maxAppt: config.maxAppt! }];

        const totalMaxAppt = isWave
          ? config.maxAppt!
          : config.streamInterval
            ? units.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
            : config.maxAppt!;

        // Create the Custom record (Specific Date)
        await tx.availability.create({
          data: {
            doctorId: doctor.id,
            date: targetDate,
            scheduleType: config.scheduleType,
            consultingStartTime: config.consultingStartTime,
            consultingEndTime: config.consultingEndTime,
            maxAppt: totalMaxAppt,
            session: config.session || null,
            slotDuration: isWave ? config.slotDuration : null,
            streamInterval: config.scheduleType === 'STREAM' ? config.streamInterval : null,
            streamBatchSize: config.scheduleType === 'STREAM' ? config.streamBatchSize : null,
            slots: { create: units },
          },
        });

        // Create the Recurring record (Day of Week) - This keeps them in sync
        await tx.availability.create({
          data: {
            doctorId: doctor.id,
            dayOfWeek: dayOfWeek,
            date: null,
            scheduleType: config.scheduleType,
            consultingStartTime: config.consultingStartTime,
            consultingEndTime: config.consultingEndTime,
            maxAppt: totalMaxAppt,
            session: config.session || null,
            slotDuration: isWave ? config.slotDuration : null,
            streamInterval: config.scheduleType === 'STREAM' ? config.streamInterval : null,
            streamBatchSize: config.scheduleType === 'STREAM' ? config.streamBatchSize : null,
            slots: { create: units },
          },
        });
      }
    });

    return {
      message: `Custom availability set successfully for ${dateStr}. Weekly schedule for ${DAY_NAMES[dayOfWeek]} has also been updated.`,
    };
  }

  // DELETE /api/v1/doctors/availability/monday
  async deleteDayAvailability(userId: string, day: string) {
    const doctor = await this.getDoctorByUserId(userId);
    const dayOfWeek = this.dayNameToNumber(day);

    await this.prisma.availability.deleteMany({
      where: {
        doctorId: doctor.id,
        dayOfWeek,
      },
    });

    return {
      message: `Availability deleted successfully for ${this.capitalize(day)}`,
    };
  }

  // DELETE /api/v1/doctors/availability/custom/:date
  async deleteCustomAvailability(userId: string, dateStr: string) {
    const doctor = await this.getDoctorByUserId(userId);
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date format');
    }

    await this.prisma.availability.deleteMany({
      where: {
        doctorId: doctor.id,
        date,
      },
    });

    return {
      message: `Custom availability deleted successfully for ${dateStr}`,
    };
  }

  // DELETE /api/v1/doctors/availability/slot/:slotId
  async deleteSlot(userId: string, slotId: string) {
    const doctor = await this.getDoctorByUserId(userId);

    // Try finding Availability block (STREAM or Entire Block)
    const block = await this.prisma.availability.findFirst({
      where: { id: slotId, doctorId: doctor.id },
    });

    if (block) {
      await this.prisma.availability.delete({ where: { id: slotId } });
      return { message: `Availability block deleted successfully` };
    }

    // Try finding AvailabilitySlot (Generated for WAVE scheduling)
    const generatedSlot = await this.prisma.availabilitySlot.findFirst({
      where: { id: slotId, availability: { doctorId: doctor.id } },
    });

    if (generatedSlot) {
      await this.prisma.availabilitySlot.delete({ where: { id: slotId } });
      return { message: `Availability slot deleted successfully` };
    }

    throw new NotFoundException('Availability slot or block not found');
  }

  // GET /api/v1/doctors/availability
  async getMyAvailability(userId: string) {
    const doctor = await this.getDoctorByUserId(userId);

    const recurring = await this.prisma.availability.findMany({
      where: { doctorId: doctor.id, date: null },
      include: { slots: true },
      orderBy: [{ dayOfWeek: 'asc' }, { consultingStartTime: 'asc' }],
    });

    const custom = await this.prisma.availability.findMany({
      where: { doctorId: doctor.id, date: { not: null } },
      include: { slots: true },
      orderBy: [{ date: 'asc' }, { consultingStartTime: 'asc' }],
    });

    const weekSchedule = DAY_NAMES.map((dayName, index) => {
      const dayAvailabilities = recurring.filter((a) => a.dayOfWeek === index);
      return {
        day: this.capitalize(dayName),
        dayOfWeek: index,
        isAvailable: dayAvailabilities.length > 0,
        availabilities: dayAvailabilities.map((a) => this.mapAvailability(a)),
      };
    });

    return {
      message: 'Availability fetched successfully',
      schedule: weekSchedule,
      customs: custom.map((a: any) => ({
        date: a.date?.toISOString().split('T')[0],
        ...this.mapAvailability(a),
      })),
    };
  }

  private mapAvailability(a: Availability & { slots: AvailabilitySlot[] }) {
    const isWave = a.scheduleType === 'WAVE';
    const units = a.slots.map((s: AvailabilitySlot) => ({
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime,
      maxAppt: s.maxAppt,
      booked: 0, // Placeholder
      available: s.maxAppt, // Placeholder
      display: isWave
        ? `${this.to12Hour(s.startTime)} to ${this.to12Hour(s.endTime)}`
        : `${this.to12Hour(s.startTime)} Stream`
    })).sort((s1, s2) => this.timeToMinutes(s1.startTime) - this.timeToMinutes(s2.startTime));

    const baseResult: any = {
      id: a.id,
      scheduleType: a.scheduleType,
      consultingStartTime: a.consultingStartTime,
      consultingEndTime: a.consultingEndTime,
      maxAppt: a.maxAppt,
      booked: 0, // Placeholder
      available: a.maxAppt, // Placeholder
      session: a.session,
      display: `${this.to12Hour(a.consultingStartTime)} to ${this.to12Hour(a.consultingEndTime)}`,
    };

    if (isWave) {
      return {
        ...baseResult,
        slotDuration: a.slotDuration,
        generatedSlots: units,
      };
    } else {
      return {
        ...baseResult,
        slotDuration: null,
      };
    }
  }
}
