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
  TimeSlotDto,
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
        availabilities: true,
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

  private validateSlots(slots: TimeSlotDto[]) {
    for (const slot of slots) {
      const start = this.timeToMinutes(slot.startTime);
      const end = this.timeToMinutes(slot.endTime);
      if (end <= start) {
        throw new BadRequestException(
          `Invalid slot: endTime (${slot.endTime}) must be after startTime (${slot.startTime})`,
        );
      }
    }

    const sorted = [...slots].sort(
      (a, b) => this.timeToMinutes(a.startTime) - this.timeToMinutes(b.startTime),
    );

    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = this.timeToMinutes(sorted[i - 1].endTime);
      const currStart = this.timeToMinutes(sorted[i].startTime);
      if (currStart < prevEnd) {
        throw new BadRequestException(
          `Overlapping slots detected: ${sorted[i - 1].startTime}-${sorted[i - 1].endTime} overlaps with ${sorted[i].startTime}-${sorted[i].endTime}`,
        );
      }
    }
  }

  // PUT /api/v1/doctors/availability/monday
  async setDayAvailability(userId: string, day: string, dto: SetDaySlotsDto) {
    const doctor = await this.getDoctorByUserId(userId);
    const dayOfWeek = this.dayNameToNumber(day);

    this.validateSlots(dto.slots);

    await this.prisma.$transaction([
      this.prisma.availability.deleteMany({
        where: {
          doctorId: doctor.id,
          dayOfWeek,
        },
      }),
      ...dto.slots.map((slot) =>
        this.prisma.availability.create({
          data: {
            doctorId: doctor.id,
            dayOfWeek,
            startTime: slot.startTime,
            endTime: slot.endTime,
          },
        }),
      ),
    ]);

    const updated = await this.prisma.availability.findMany({
      where: { doctorId: doctor.id, dayOfWeek },
      orderBy: { startTime: 'asc' },
    });

    return {
      message: `Availability set for ${this.capitalize(day)}`,
      day: this.capitalize(day),
      slots: updated.map((a) => ({
        id: a.id,
        startTime: a.startTime,
        endTime: a.endTime,
        display: `${this.to12Hour(a.startTime)} to ${this.to12Hour(a.endTime)}`,
      })),
    };
  }

  // PUT /api/v1/doctors/availability (week)
  async setWeekAvailability(userId: string, dto: SetWeekAvailabilityDto) {
    const doctor = await this.getDoctorByUserId(userId);

    for (const daySchedule of dto.schedule) {
      this.dayNameToNumber(daySchedule.day); // validate day name
      this.validateSlots(daySchedule.slots);
    }

    const daysToUpdate = dto.schedule.map((d) => this.dayNameToNumber(d.day));

    await this.prisma.$transaction([
      this.prisma.availability.deleteMany({
        where: {
          doctorId: doctor.id,
          dayOfWeek: { in: daysToUpdate },
        },
      }),
      ...dto.schedule.flatMap((daySchedule) =>
        daySchedule.slots.map((slot) =>
          this.prisma.availability.create({
            data: {
              doctorId: doctor.id,
              dayOfWeek: this.dayNameToNumber(daySchedule.day),
              startTime: slot.startTime,
              endTime: slot.endTime,
            },
          }),
        ),
      ),
    ]);

    return this.getMyAvailability(userId);
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
      message: `All availability removed for ${this.capitalize(day)}`,
    };
  }

  // DELETE /api/v1/doctors/availability/slot/:slotId
  async deleteSlot(userId: string, slotId: string) {
    const doctor = await this.getDoctorByUserId(userId);

    const slot = await this.prisma.availability.findFirst({
      where: { id: slotId, doctorId: doctor.id },
    });

    if (!slot) {
      throw new NotFoundException('Availability slot not found');
    }

    await this.prisma.availability.delete({ where: { id: slotId } });

    return {
      message: `Slot ${this.to12Hour(slot.startTime)} to ${this.to12Hour(slot.endTime)} on ${this.capitalize(DAY_NAMES[slot.dayOfWeek])} removed`,
    };
  }

  // GET /api/v1/doctors/availability
  async getMyAvailability(userId: string) {
    const doctor = await this.getDoctorByUserId(userId);

    const availabilities = await this.prisma.availability.findMany({
      where: { doctorId: doctor.id },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    const weekSchedule = DAY_NAMES.map((dayName, index) => {
      const daySlots = availabilities.filter((a) => a.dayOfWeek === index);
      return {
        day: this.capitalize(dayName),
        dayOfWeek: index,
        isAvailable: daySlots.length > 0,
        slots: daySlots.map((a) => ({
          id: a.id,
          startTime: a.startTime,
          endTime: a.endTime,
          display: `${this.to12Hour(a.startTime)} to ${this.to12Hour(a.endTime)}`,
        })),
      };
    });

    return { schedule: weekSchedule };
  }
}
