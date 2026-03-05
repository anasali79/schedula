import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateSpecializationDto } from './dto/create-specialization.dto';
import {
  SetDaySlotsDto,
  SetWeekAvailabilityDto,
  AvailabilityConfigDto,
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
  constructor(private readonly prisma: PrismaService) { }

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

  private generateWaveSlots(startMinutes: number, endMinutes: number, duration: number, maxAppt: number) {
    const slots: { startTime: string; endTime: string; maxAppt: number }[] = [];
    let current = startMinutes;

    while (current < endMinutes) {
      const next = current + duration;
      if (next > endMinutes) break; // Don't create partial slots

      const stHour = Math.floor(current / 60).toString().padStart(2, '0');
      const stMin = (current % 60).toString().padStart(2, '0');

      const enHour = Math.floor(next / 60).toString().padStart(2, '0');
      const enMin = (next % 60).toString().padStart(2, '0');

      slots.push({
        startTime: `${stHour}:${stMin}`,
        endTime: `${enHour}:${enMin}`,
        maxAppt
      });

      current = next;
    }

    return slots;
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

      if (config.scheduleType === 'WAVE') {
        if (!config.slotDuration) {
          throw new BadRequestException('slotDuration is required for WAVE scheduling');
        }
        const diff = end - start;
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
        const generatedSlots = config.scheduleType === 'WAVE'
          ? this.generateWaveSlots(
            this.timeToMinutes(config.consultingStartTime),
            this.timeToMinutes(config.consultingEndTime),
            config.slotDuration!,
            config.maxAppt
          )
          : [];

        await tx.availability.create({
          data: {
            doctorId: doctor.id,
            dayOfWeek,
            scheduleType: config.scheduleType,
            consultingStartTime: config.consultingStartTime,
            consultingEndTime: config.consultingEndTime,
            maxAppt: config.maxAppt,
            session: config.session || null,
            slotDuration: config.slotDuration || null,
            slots: generatedSlots.length > 0 ? { create: generatedSlots } : undefined,
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
          const generatedSlots = config.scheduleType === 'WAVE'
            ? this.generateWaveSlots(
              this.timeToMinutes(config.consultingStartTime),
              this.timeToMinutes(config.consultingEndTime),
              config.slotDuration!,
              config.maxAppt
            )
            : [];

          await tx.availability.create({
            data: {
              doctorId: doctor.id,
              dayOfWeek,
              scheduleType: config.scheduleType,
              consultingStartTime: config.consultingStartTime,
              consultingEndTime: config.consultingEndTime,
              maxAppt: config.maxAppt,
              session: config.session || null,
              slotDuration: config.slotDuration || null,
              slots: generatedSlots.length > 0 ? { create: generatedSlots } : undefined,
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

    const availabilities = await this.prisma.availability.findMany({
      where: { doctorId: doctor.id },
      include: { slots: true },
      orderBy: [{ dayOfWeek: 'asc' }, { consultingStartTime: 'asc' }],
    });

    const weekSchedule = DAY_NAMES.map((dayName, index) => {
      const dayAvailabilities = availabilities.filter((a) => a.dayOfWeek === index);
      return {
        day: this.capitalize(dayName),
        dayOfWeek: index,
        isAvailable: dayAvailabilities.length > 0,
        availabilities: dayAvailabilities.map((a) => ({
          id: a.id,
          scheduleType: a.scheduleType,
          consultingStartTime: a.consultingStartTime,
          consultingEndTime: a.consultingEndTime,
          maxAppt: a.maxAppt,
          booked: 0, // Placeholder for tracking booked slots
          available: a.maxAppt, // Placeholder for tracking available slots
          session: a.session,
          slotDuration: a.slotDuration,
          display: `${this.to12Hour(a.consultingStartTime)} to ${this.to12Hour(a.consultingEndTime)}`,
          ...(a.scheduleType === 'WAVE' ? {
            generatedSlots: a.slots.map(s => ({
              id: s.id,
              startTime: s.startTime,
              endTime: s.endTime,
              maxAppt: s.maxAppt,
              booked: 0, // Placeholder for tracking booked slots
              available: s.maxAppt, // Placeholder for tracking available slots
              display: `${this.to12Hour(s.startTime)} to ${this.to12Hour(s.endTime)}`
            })).sort((s1, s2) => this.timeToMinutes(s1.startTime) - this.timeToMinutes(s2.startTime))
          } : {})
        })),
      };
    });

    return {
      message: 'Availability fetched successfully',
      schedule: weekSchedule
    };
  }
}
