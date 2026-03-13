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
  GenerateWaveSlotsDto,
  UpdateWaveSlotsDto,
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

  async listDoctors(specialization?: string) {
    return this.prisma.doctor.findMany({
      where: {
        ...(specialization && {
          specializations: {
            some: {
              name: {
                contains: specialization,
                mode: 'insensitive',
              },
            },
          },
        }),
      },
      include: {
        profile: true,
        specializations: true,
      },
    });
  }

  async getDoctorAvailability(doctorId: string, date?: string) {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
    });
    if (!doctor) throw new NotFoundException('Doctor not found');

    return this.fetchAvailability(doctor, date);
  }

  async getMyAvailability(userId: string, date?: string) {
    const doctor = await this.getDoctorByUserId(userId);
    return this.fetchAvailability(doctor, date);
  }

  private async fetchAvailability(doctor: any, dateStr?: string) {
    const targetDate = dateStr ? new Date(dateStr) : null;

    // Fetch bookings for this doctor. 
    // If a specific date is requested, fetch for that date only.
    // Otherwise, fetch from today onwards to populate the upcoming list.
    let bookedMap: Record<string, number> = {};
    const apptWhere: any = {
      doctorId: doctor.id,
      status: { in: ['CONFIRMED'] }
    };

    if (targetDate && !isNaN(targetDate.getTime())) {
      const startOfDay = new Date(targetDate);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setUTCHours(23, 59, 59, 999);
      apptWhere.appointmentDate = { gte: startOfDay, lte: endOfDay };
    } else {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      apptWhere.appointmentDate = { gte: today };
    }

    const appointments = await this.prisma.appointment.findMany({
      where: apptWhere,
      select: { slotId: true }
    });

    appointments.forEach(a => {
      bookedMap[a.slotId] = (bookedMap[a.slotId] || 0) + 1;
    });

    // If a specific date is queried, check for a real date record first
    if (targetDate && !isNaN(targetDate.getTime())) {
      const dateRecords = await this.prisma.availability.findMany({
        where: {
          doctorId: doctor.id,
          date: targetDate,
        },
        include: { slots: true, elasticSlots: { include: { allocations: true } } },
        orderBy: { consultingStartTime: 'asc' },
      });

      if (dateRecords.length > 0) {
        // We have real date records — use them directly
        const dayOfWeek = targetDate.getUTCDay();
        return {
          message: 'Availability fetched successfully',
          doctor: {
            id: doctor.id,
            firstName: doctor.firstName,
            lastName: doctor.lastName,
          },
          targetDate: targetDate.toISOString().split('T')[0],
          day: this.capitalize(DAY_NAMES[dayOfWeek]),
          dayOfWeek,
          isAvailable: true,
          availabilities: dateRecords.map((a: any) => this.mapAvailability(a, bookedMap, targetDate)),
        };
      }
    }

    // Fallback: use the recurring template (date: null)
    const recurring = await this.prisma.availability.findMany({
      where: { doctorId: doctor.id, date: null },
      include: { slots: true, elasticSlots: { include: { allocations: true } } },
      orderBy: [{ dayOfWeek: 'asc' }, { consultingStartTime: 'asc' }],
    });

    // If a target date is provided, show only that day from the template
    if (targetDate && !isNaN(targetDate.getTime())) {
      const dayOfWeek = targetDate.getUTCDay();
      const dayAvailabilities = recurring.filter((a) => a.dayOfWeek === dayOfWeek);
      return {
        message: 'Availability fetched successfully',
        doctor: {
          id: doctor.id,
          firstName: doctor.firstName,
          lastName: doctor.lastName,
        },
        targetDate: targetDate.toISOString().split('T')[0],
        day: this.capitalize(DAY_NAMES[dayOfWeek]),
        dayOfWeek,
        isAvailable: dayAvailabilities.length > 0,
        availabilities: dayAvailabilities.map((a) => this.mapAvailability(a, bookedMap, targetDate)),
      };
    }

    // No date provided — return full week schedule + upcoming real dates
    const realDates = await this.prisma.availability.findMany({
      where: {
        doctorId: doctor.id,
        date: { not: null, gte: new Date() },
      },
      include: { slots: true, elasticSlots: { include: { allocations: true } } },
      orderBy: [{ date: 'asc' }, { consultingStartTime: 'asc' }],
    });

    const weekSchedule = DAY_NAMES.map((dayName, index) => {
      const dayAvailabilities = recurring.filter((a) => a.dayOfWeek === index);

      // Calculate date for this day in the CURRENT calendar week (Sun-Sat)
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const currentDay = today.getUTCDay();
      
      const diff = index - currentDay;
      const weekDate = new Date(today);
      weekDate.setUTCDate(today.getUTCDate() + diff);
      const weekDateStr = weekDate.toISOString().split('T')[0];

      return {
        day: this.capitalize(dayName),
        dayOfWeek: index,
        date: weekDateStr,
        isAvailable: dayAvailabilities.length > 0,
        availabilities: dayAvailabilities.map((a) => this.mapAvailability(a, {}, weekDate)),
      };
    });

    // Group real dates by date
    const upcomingDates: Record<string, any[]> = {};
    for (const rd of realDates) {
      const dateKey = (rd.date as Date).toISOString().split('T')[0];
      if (!upcomingDates[dateKey]) upcomingDates[dateKey] = [];
      upcomingDates[dateKey].push(this.mapAvailability(rd as any, bookedMap, rd.date));
    }

    return {
      message: 'Availability fetched successfully',
      doctor: {
        id: doctor.id,
        firstName: doctor.firstName,
        lastName: doctor.lastName,
      },
      targetDate: null,
      schedule: weekSchedule,
      upcomingDates: Object.entries(upcomingDates).map(([date, avails]) => {
        const d = new Date(date);
        return {
          date,
          day: this.capitalize(DAY_NAMES[d.getUTCDay()]),
          formattedDate: d.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric'
          }),
          availabilities: avails,
        };
      }),
    };
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

  generateWaveSlotsPreview(dto: GenerateWaveSlotsDto) {
    const start = this.timeToMinutes(dto.startTime);
    const end = this.timeToMinutes(dto.endTime);
    const diff = end - start;

    if (diff <= 0) {
      throw new BadRequestException('endTime must be after startTime');
    }

    if (diff % dto.slotDuration !== 0) {
      throw new BadRequestException(`slotDuration (${dto.slotDuration} min) must perfectly divide the time range (${diff} min)`);
    }

    const slotCount = diff / dto.slotDuration;
    const baseCapacity = dto.totalMaxAppt ? Math.floor(dto.totalMaxAppt / slotCount) : 0;
    let extra = dto.totalMaxAppt ? dto.totalMaxAppt % slotCount : 0;

    const slots = [];
    let current = start;

    for (let i = 0; i < slotCount; i++) {
      const next = current + dto.slotDuration;
      const capacity = baseCapacity + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;

      slots.push({
        startTime: this.minutesToTime(current),
        endTime: this.minutesToTime(next),
        maxAppt: capacity,
      });
      current = next;
    }

    return {
      startTime: dto.startTime,
      endTime: dto.endTime,
      slotDuration: dto.slotDuration,
      totalMaxAppt: dto.totalMaxAppt || 0,
      slots,
    };
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

  private getDatesForNextMonth(dayOfWeek: number, startDate?: Date): Date[] {
    const dates: Date[] = [];
    const today = startDate ? new Date(startDate) : new Date();
    today.setUTCHours(0, 0, 0, 0);

    const currentDay = today.getUTCDay();
    const daysUntilNext = (dayOfWeek - currentDay + 7) % 7;

    const nextDate = new Date(today);
    nextDate.setUTCDate(today.getUTCDate() + daysUntilNext);

    const oneMonthFromNow = new Date(today);
    oneMonthFromNow.setUTCMonth(today.getUTCMonth() + 1);

    while (nextDate <= oneMonthFromNow) {
      dates.push(new Date(nextDate));
      nextDate.setUTCDate(nextDate.getUTCDate() + 7);
    }

    return dates;
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

        if (config.slots && config.slots.length > 0) {
          const totalFromSlots = config.slots.reduce((sum, s) => sum + s.maxAppt, 0);
          if (config.maxAppt && config.maxAppt !== totalFromSlots) {
            throw new BadRequestException(`Sum of slot capacities (${totalFromSlots}) does not match the total maxAppt (${config.maxAppt})`);
          }
        }

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

      const nextMonthDates = this.getDatesForNextMonth(dayOfWeek);

      for (const config of dto.availabilities) {
        const start = this.timeToMinutes(config.consultingStartTime);
        const end = this.timeToMinutes(config.consultingEndTime);

        const isWave = config.scheduleType === 'WAVE';

        // Helper to generate fresh units for each record
        const getUnits = () => isWave
          ? config.slots && config.slots.length > 0
            ? config.slots.map(s => ({ startTime: s.startTime, endTime: s.endTime, maxAppt: s.maxAppt }))
            : this.generateWaveSlotsPreview({
              startTime: config.consultingStartTime,
              endTime: config.consultingEndTime,
              slotDuration: config.slotDuration!,
              totalMaxAppt: config.maxAppt,
            }).slots
          : config.streamInterval
            ? this.generateStreamBatches(start, end, config.streamInterval!, config.streamBatchSize!)
            : [{ startTime: config.consultingStartTime, endTime: config.consultingEndTime, maxAppt: config.maxAppt! }];

        const unitsForTemplate = getUnits();
        const totalMaxAppt = isWave
          ? unitsForTemplate.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
          : config.streamInterval
            ? unitsForTemplate.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
            : config.maxAppt!;

        // 1. Create the base template (date: null)
        await tx.availability.create({
          data: {
            doctorId: doctor.id,
            dayOfWeek,
            date: null,
            scheduleType: config.scheduleType,
            consultingStartTime: config.consultingStartTime,
            consultingEndTime: config.consultingEndTime,
            maxAppt: totalMaxAppt,
            session: config.session || null,
            slotDuration: isWave ? config.slotDuration : null,
            streamInterval: config.scheduleType === 'STREAM' ? config.streamInterval : null,
            streamBatchSize: config.scheduleType === 'STREAM' ? config.streamBatchSize : null,
            slots: { create: unitsForTemplate },
          },
        });

        // 2. Create the real date records for the next 1 month
        for (const targetDate of nextMonthDates) {
          const expectedUnits = getUnits();
          await tx.availability.create({
            data: {
              doctorId: doctor.id,
              dayOfWeek,
              date: targetDate,
              scheduleType: config.scheduleType,
              consultingStartTime: config.consultingStartTime,
              consultingEndTime: config.consultingEndTime,
              maxAppt: totalMaxAppt,
              session: config.session || null,
              slotDuration: isWave ? config.slotDuration : null,
              streamInterval: config.scheduleType === 'STREAM' ? config.streamInterval : null,
              streamBatchSize: config.scheduleType === 'STREAM' ? config.streamBatchSize : null,
              slots: { create: expectedUnits },
            },
          });
        }
      }
    });

    const generatedDates = this.getDatesForNextMonth(dayOfWeek).map(d => d.toISOString().split('T')[0]);
    const scheduleData = await this.getMyAvailability(userId);
    return {
      message: `Availability ${isUpdate ? 'updated' : 'created'} successfully for ${this.capitalize(day)}`,
      recurringDates: generatedDates,
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
        const nextMonthDates = this.getDatesForNextMonth(dayOfWeek);

        for (const config of daySchedule.availabilities) {
          const start = this.timeToMinutes(config.consultingStartTime);
          const end = this.timeToMinutes(config.consultingEndTime);

          const isWave = config.scheduleType === 'WAVE';

          const getUnits = () => isWave
            ? config.slots && config.slots.length > 0
              ? config.slots.map(s => ({ startTime: s.startTime, endTime: s.endTime, maxAppt: s.maxAppt }))
              : this.generateWaveSlotsPreview({
                startTime: config.consultingStartTime,
                endTime: config.consultingEndTime,
                slotDuration: config.slotDuration!,
                totalMaxAppt: config.maxAppt,
              }).slots
            : config.streamInterval
              ? this.generateStreamBatches(start, end, config.streamInterval!, config.streamBatchSize!)
              : [{ startTime: config.consultingStartTime, endTime: config.consultingEndTime, maxAppt: config.maxAppt! }];

          const unitsForTemplate = getUnits();
          const totalMaxAppt = isWave
            ? unitsForTemplate.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
            : config.streamInterval
              ? unitsForTemplate.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
              : config.maxAppt!;

          // 1. Base template
          await tx.availability.create({
            data: {
              doctorId: doctor.id,
              dayOfWeek,
              date: null,
              scheduleType: config.scheduleType,
              consultingStartTime: config.consultingStartTime,
              consultingEndTime: config.consultingEndTime,
              maxAppt: totalMaxAppt,
              session: config.session || null,
              slotDuration: isWave ? config.slotDuration : null,
              streamInterval: config.scheduleType === 'STREAM' ? config.streamInterval : null,
              streamBatchSize: config.scheduleType === 'STREAM' ? config.streamBatchSize : null,
              slots: { create: unitsForTemplate },
            },
          });

          // 2. Real date mappings for 1 month
          for (const targetDate of nextMonthDates) {
            const expectedUnits = getUnits();
            await tx.availability.create({
              data: {
                doctorId: doctor.id,
                dayOfWeek,
                date: targetDate,
                scheduleType: config.scheduleType,
                consultingStartTime: config.consultingStartTime,
                consultingEndTime: config.consultingEndTime,
                maxAppt: totalMaxAppt,
                session: config.session || null,
                slotDuration: isWave ? config.slotDuration : null,
                streamInterval: config.scheduleType === 'STREAM' ? config.streamInterval : null,
                streamBatchSize: config.scheduleType === 'STREAM' ? config.streamBatchSize : null,
                slots: { create: expectedUnits },
              },
            });
          }
        }
      }
    });

    const allGeneratedDates: string[] = [];
    for (const daySchedule of dto.schedule) {
      const dow = this.dayNameToNumber(daySchedule.day);
      const dates = this.getDatesForNextMonth(dow).map(d => d.toISOString().split('T')[0]);
      allGeneratedDates.push(...dates);
    }
    const scheduleData = await this.getMyAvailability(userId);
    return {
      message: `Weekly availability ${isUpdate ? 'updated' : 'created'} successfully`,
      recurringDates: allGeneratedDates.sort(),
      schedule: scheduleData.schedule
    };
  }

  // PUT /api/v1/doctors/custom-availability/:date
  // Override a SINGLE specific date only — template & other dates remain untouched
  async setCustomAvailability(userId: string, dateStr: string, dto: SetCustomAvailabilityDto) {
    const doctor = await this.getDoctorByUserId(userId);
    const targetDate = new Date(dateStr);
    if (isNaN(targetDate.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD');
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const checkDate = new Date(targetDate);
    checkDate.setUTCHours(0, 0, 0, 0);

    if (checkDate < today) {
      throw new BadRequestException('Cannot set availability for past dates');
    }

    const dayOfWeek = targetDate.getUTCDay();
    this.validateAvailabilities(dto.availabilities);

    let isUpdate = false;

    await this.prisma.$transaction(async (tx) => {
      // Only delete the record for THIS specific date — don't touch template or other dates
      const deletedCustom = await tx.availability.deleteMany({
        where: { doctorId: doctor.id, date: targetDate },
      });

      if (deletedCustom.count > 0) isUpdate = true;

      // Create new availability records for ONLY this specific date
      for (const config of dto.availabilities) {
        const start = this.timeToMinutes(config.consultingStartTime);
        const end = this.timeToMinutes(config.consultingEndTime);

        const isWave = config.scheduleType === 'WAVE';
        const units = isWave
          ? config.slots && config.slots.length > 0
            ? config.slots.map(s => ({ startTime: s.startTime, endTime: s.endTime, maxAppt: s.maxAppt }))
            : this.generateWaveSlotsPreview({
              startTime: config.consultingStartTime,
              endTime: config.consultingEndTime,
              slotDuration: config.slotDuration!,
              totalMaxAppt: config.maxAppt,
            }).slots
          : config.streamInterval
            ? this.generateStreamBatches(start, end, config.streamInterval!, config.streamBatchSize!)
            : [{ startTime: config.consultingStartTime, endTime: config.consultingEndTime, maxAppt: config.maxAppt! }];

        const totalMaxAppt = isWave
          ? units.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
          : config.streamInterval
            ? units.reduce((sum: number, u: any) => sum + u.maxAppt, 0)
            : config.maxAppt!;

        // Create record for THIS date only
        await tx.availability.create({
          data: {
            doctorId: doctor.id,
            dayOfWeek: dayOfWeek,
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
      }
    });

    return {
      message: `Custom availability ${isUpdate ? 'updated' : 'set'} for ${dateStr} (${this.capitalize(DAY_NAMES[dayOfWeek])}). Other ${DAY_NAMES[dayOfWeek]}s remain unchanged.`,
      date: dateStr,
      day: this.capitalize(DAY_NAMES[dayOfWeek]),
    };
  }

  // DELETE /api/v1/doctors/availability/monday
  // Deletes both the recurring template AND all real date records for that day
  async deleteDayAvailability(userId: string, day: string) {
    const doctor = await this.getDoctorByUserId(userId);
    const dayOfWeek = this.dayNameToNumber(day);

    // Delete both template (date: null) and all real date records for this dayOfWeek
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


  async updateWaveSlots(userId: string, availabilityId: string, dto: UpdateWaveSlotsDto) {
    const doctor = await this.getDoctorByUserId(userId);

    const availability = await this.prisma.availability.findFirst({
      where: { id: availabilityId, doctorId: doctor.id },
      include: { slots: true, elasticSlots: { include: { allocations: true } } }
    });

    if (!availability) {
      throw new NotFoundException('Availability not found');
    }

    if (availability.scheduleType !== 'WAVE') {
      throw new BadRequestException('Slots can only be updated for WAVE scheduling');
    }

    const totalFromSlots = dto.slots.reduce((sum, s) => sum + s.maxAppt, 0);
    if (availability.maxAppt !== totalFromSlots) {
      throw new BadRequestException(`Sum of slot capacities (${totalFromSlots}) must match availability total (${availability.maxAppt})`);
    }

    // Replace existing slots
    await this.prisma.$transaction([
      this.prisma.availabilitySlot.deleteMany({ where: { availabilityId } }),
      this.prisma.availabilitySlot.createMany({
        data: dto.slots.map(s => ({
          availabilityId,
          startTime: s.startTime,
          endTime: s.endTime,
          maxAppt: s.maxAppt
        }))
      })
    ]);

    return { message: 'Slots updated successfully', totalMaxAppt: totalFromSlots };
  }
  private mapAvailability(a: Availability & { slots: AvailabilitySlot[], elasticSlots?: any[] }, bookedMap: Record<string, number> = {}, dateOverride?: Date | null) {
    const isWave = a.scheduleType === 'WAVE';
    const activeDate = dateOverride || a.date;
    const dateStr = activeDate ? (activeDate instanceof Date ? activeDate.toISOString().split('T')[0] : activeDate) : null;

    // Map Elastic Slots
    const elasticUnits = (a.elasticSlots || []).filter((es: any) => es.isActive).map((es: any) => {
      // Find booked count from slotAllocations or directly if stored differently
      // Let's assume allocations hold current booked for now
      const booked = es.allocations?.length || 0;
      return {
        id: es.id,
        date: dateStr,
        startTime: es.startTime,
        endTime: es.endTime,
        maxAppt: es.maxPerSlot,
        booked,
        available: Math.max(0, es.maxPerSlot - booked),
        display: isWave
          ? `${this.to12Hour(es.startTime)} to ${this.to12Hour(es.endTime)}`
          : `${this.to12Hour(es.startTime)} Stream`,
        isElastic: true
      };
    });

    const units = [
      ...a.slots.map((s: AvailabilitySlot) => {
        const booked = bookedMap[s.id] || 0;
        return {
          id: s.id,
          date: dateStr,
          startTime: s.startTime,
          endTime: s.endTime,
          maxAppt: s.maxAppt,
          booked,
          available: Math.max(0, s.maxAppt - booked),
          display: isWave
            ? `${this.to12Hour(s.startTime)} to ${this.to12Hour(s.endTime)}`
            : `${this.to12Hour(s.startTime)} Stream`,
          isElastic: false
        };
      }),
      ...elasticUnits
    ].sort((s1, s2) => this.timeToMinutes(s1.startTime) - this.timeToMinutes(s2.startTime));

    // For STREAM mode
    // We update maxAppt logic to include elastic maxAppt
    const elasticMaxAppt = elasticUnits.reduce((sum: number, u: any) => sum + u.maxAppt, 0);
    const totalMaxAppt = a.maxAppt + elasticMaxAppt;

    const baseBooked = isWave ? units.reduce((sum, u) => sum + u.booked, 0) : (Object.values(bookedMap).reduce((sum, val) => sum + val, 0) + elasticUnits.reduce((sum: number, u: any) => sum + u.booked, 0));

    const baseResult: any = {
      id: a.id,
      date: dateStr,
      scheduleType: a.scheduleType,
      consultingStartTime: a.consultingStartTime,
      consultingEndTime: a.consultingEndTime,
      maxAppt: totalMaxAppt,
      booked: baseBooked,
      available: Math.max(0, totalMaxAppt - baseBooked),
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
