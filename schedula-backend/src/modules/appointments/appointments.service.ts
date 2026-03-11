import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppointmentStatus, Role } from '@prisma/client';
import { BookAppointmentDto } from './dto/book-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import { EmailService } from '../email/email.service';

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) { }

  private to12Hour(time: string): string {
    const [h, m] = time.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
  }

  private timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  private calculateReportingTime(startTime: string, endTime: string, maxAppt: number, token: number): string {
    const start = this.timeToMinutes(startTime);
    const end = this.timeToMinutes(endTime);
    const duration = end - start;

    // Formula: floor((token - 1) * duration / maxAppt)
    const offset = Math.floor(((token - 1) * duration) / maxAppt);
    const reportingMinutes = start + offset;

    const h = Math.floor(reportingMinutes / 60);
    const m = reportingMinutes % 60;

    return this.to12Hour(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
  }

  async bookAppointment(userId: string, dto: BookAppointmentDto) {
    const patient = await this.prisma.patient.findUnique({
      where: { userId },
      include: { user: true },
    });
    if (!patient) {
      throw new NotFoundException('Patient profile not found. Please onboard first.');
    }

    const { slotId, appointmentDate, notes } = dto;
    const date = new Date(appointmentDate);
    if (isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD');
    }

    // Validate: date should not be in the past
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const bookingDate = new Date(date);
    bookingDate.setUTCHours(0, 0, 0, 0);

    if (bookingDate < today) {
      throw new BadRequestException('Cannot book appointments for past dates');
    }

    // 1. Get Slot with full availability + doctor info
    const slot = await this.prisma.availabilitySlot.findUnique({
      where: { id: slotId },
      include: {
        availability: {
          include: {
            doctor: {
              include: {
                user: true,
                profile: true,
                specializations: true,
              },
            },
          },
        },
      },
    });

    if (!slot) {
      throw new NotFoundException('Slot not found');
    }

    const availability = slot.availability;
    const doctor = availability.doctor;
    const doctorId = doctor.id;

    // 2. Validate: appointmentDate must match the slot's availability date
    if (availability.date) {
      // Slot belongs to a real date record — appointmentDate must match
      const slotDate = availability.date.toISOString().split('T')[0];
      const requestedDate = bookingDate.toISOString().split('T')[0];
      if (slotDate !== requestedDate) {
        throw new BadRequestException(
          `This slot is for ${slotDate}, but you requested ${requestedDate}. Please use the correct date.`
        );
      }
    } else {
      // Slot belongs to a recurring template — verify the day of week matches
      const requestedDayOfWeek = bookingDate.getUTCDay();
      if (availability.dayOfWeek !== null && availability.dayOfWeek !== requestedDayOfWeek) {
        const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        throw new BadRequestException(
          `This slot is for ${DAY_NAMES[availability.dayOfWeek]}, but ${appointmentDate} is a ${DAY_NAMES[requestedDayOfWeek]}.`
        );
      }
    }

    // 3. Check if the slot is full for that date
    const startOfDay = new Date(bookingDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(bookingDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const bookedCount = await this.prisma.appointment.count({
      where: {
        slotId: slot.id,
        appointmentDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
        status: { in: [AppointmentStatus.CONFIRMED] },
      },
    });

    if (bookedCount >= slot.maxAppt) {
      throw new BadRequestException(
        `This slot is fully booked (${slot.maxAppt}/${slot.maxAppt}). Please choose another slot.`
      );
    }

    // 4. Check if patient already has an appointment for this slot on this date
    const existingAppointment = await this.prisma.appointment.findFirst({
      where: {
        patientId: patient.id,
        slotId: slot.id,
        appointmentDate: startOfDay,
      },
    });

    if (existingAppointment) {
      if (existingAppointment.status === AppointmentStatus.CANCELLED) {
        throw new BadRequestException(
          'You have a cancelled appointment for this slot. Please choose another slot or contact support to reactivate.'
        );
      }
      throw new BadRequestException('You have already booked an appointment for this slot.');
    }

    // 5. Generate Token
    const tokenNumber = bookedCount + 1;

    // 6. Create appointment
    const appointment = await this.prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId,
        slotId,
        appointmentDate: startOfDay,
        notes,
        status: AppointmentStatus.CONFIRMED,
      },
    });

    // 7. Build response
    const doctorName = `Dr. ${doctor.firstName}${doctor.lastName ? ' ' + doctor.lastName : ''}`;
    const patientName = `${patient.firstName}${patient.lastName ? ' ' + patient.lastName : ''}`;
    const slotDisplay = `${this.to12Hour(slot.startTime)} to ${this.to12Hour(slot.endTime)}`;
    const dateDisplay = bookingDate.toISOString().split('T')[0]; // YYYY-MM-DD
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = DAY_NAMES[bookingDate.getUTCDay()];

    const isWave = availability.scheduleType === 'WAVE';
    const reportingTime = isWave
      ? this.calculateReportingTime(slot.startTime, slot.endTime, slot.maxAppt, tokenNumber)
      : this.to12Hour(slot.startTime);

    // 8. Send Email Notification
    try {
      await this.emailService.sendAppointmentConfirmation({
        to: patient.user.email,
        patientName,
        doctorName,
        date: dateDisplay,
        day: dayName,
        slotTime: slotDisplay,
        token: tokenNumber,
        reportingTime,
        appointmentId: appointment.id,
        notes: notes || undefined,
      });
    } catch (e) {
      console.error('Email failed to send', e);
    }

    return {
      message: 'Appointment booked successfully',
      appointment: {
        id: appointment.id,
        date: dateDisplay,
        reportingTime,
        ...(isWave && { slotTime: `${this.to12Hour(slot.startTime)} to ${this.to12Hour(slot.endTime)}` }),
        token: tokenNumber,
        doctorName,
        status: appointment.status,
      },
    };
  }

  async getMyAppointments(userId: string, role: Role) {
    if (role === Role.PATIENT) {
      const patient = await this.prisma.patient.findUnique({
        where: { userId },
      });
      if (!patient) {
        throw new NotFoundException('Patient not found');
      }

      const appointments = await this.prisma.appointment.findMany({
        where: { patientId: patient.id },
        include: {
          doctor: {
            include: {
              profile: true,
              specializations: true,
            },
          },
          slot: true,
        },
        orderBy: { appointmentDate: 'desc' },
      });

      const upcoming = appointments.filter(a => a.status === AppointmentStatus.CONFIRMED && !a.isRescheduled && new Date(a.appointmentDate) >= new Date());
      const rescheduled = appointments.filter(a => a.isRescheduled && a.status === AppointmentStatus.CONFIRMED);
      const completed = appointments.filter(a => a.status === AppointmentStatus.COMPLETED);
      const cancelled = appointments.filter(a => a.status === AppointmentStatus.CANCELLED);

      return {
        message: 'Patient appointment history fetched successfully',
        summary: {
          total: appointments.length,
          upcoming: upcoming.length,
          rescheduled: rescheduled.length,
          completed: completed.length,
          cancelled: cancelled.length,
        },
        history: {
          upcoming: upcoming.map(a => this.formatAppointment(a, 'doctor')),
          rescheduled: rescheduled.map(a => this.formatAppointment(a, 'doctor')),
          completed: completed.map(a => this.formatAppointment(a, 'doctor')),
          cancelled: cancelled.map(a => this.formatAppointment(a, 'doctor')),
        }
      };
    } else {
      // Role is DOCTOR
      const doctor = await this.prisma.doctor.findUnique({
        where: { userId },
      });
      if (!doctor) {
        throw new NotFoundException('Doctor profile not found');
      }

      const appointments = await this.prisma.appointment.findMany({
        where: { doctorId: doctor.id },
        include: {
          patient: true,
          slot: true,
        },
        orderBy: { appointmentDate: 'desc' },
      });

      const upcoming = appointments.filter(a => a.status === AppointmentStatus.CONFIRMED && !a.isRescheduled && new Date(a.appointmentDate) >= new Date());
      const rescheduled = appointments.filter(a => a.isRescheduled && a.status === AppointmentStatus.CONFIRMED);
      const completed = appointments.filter(a => a.status === AppointmentStatus.COMPLETED);
      const cancelled = appointments.filter(a => a.status === AppointmentStatus.CANCELLED);

      return {
        message: 'Doctor appointment history fetched successfully',
        summary: {
          total: appointments.length,
          upcoming: upcoming.length,
          rescheduled: rescheduled.length,
          completed: completed.length,
          cancelled: cancelled.length,
        },
        history: {
          upcoming: upcoming.map(a => this.formatAppointment(a, 'patient')),
          rescheduled: rescheduled.map(a => this.formatAppointment(a, 'patient')),
          completed: completed.map(a => this.formatAppointment(a, 'patient')),
          cancelled: cancelled.map(a => this.formatAppointment(a, 'patient')),
        }
      };
    }
  }

  private formatAppointment(a: any, profileType: 'doctor' | 'patient') {
    const profile = a[profileType];
    const name = profileType === 'doctor' 
      ? `Dr. ${profile.firstName}${profile.lastName ? ' ' + profile.lastName : ''}`
      : `${profile.firstName}${profile.lastName ? ' ' + profile.lastName : ''}`;

    return {
      id: a.id,
      date: a.appointmentDate.toISOString().split('T')[0],
      time: `${this.to12Hour(a.slot.startTime)} - ${this.to12Hour(a.slot.endTime)}`,
      status: a.status,
      notes: a.notes,
      [profileType]: {
        id: profile.id,
        name: name,
        ...(profileType === 'patient' && { phone: profile.phone }),
        ...(profileType === 'doctor' && { specializations: profile.specializations?.map((s: any) => s.name) }),
      }
    };
  }

  async cancelAppointment(userId: string, role: Role, appointmentId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: { include: { user: true } },
        doctor: { include: { user: true } },
        slot: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Authorization check
    if (role === Role.PATIENT) {
      if (appointment.patient.userId !== userId) {
        throw new BadRequestException('You are not authorized to cancel this appointment');
      }
    } else if (role === Role.DOCTOR) {
      if (appointment.doctor.userId !== userId) {
        throw new BadRequestException('You are not authorized to cancel this appointment');
      }
    }

    if (appointment.status === AppointmentStatus.CANCELLED) {
      throw new BadRequestException('Appointment is already cancelled');
    }

    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: AppointmentStatus.CANCELLED },
    });

    // Send Email Notifications to both parties
    const patientName = `${appointment.patient.firstName}${appointment.patient.lastName ? ' ' + appointment.patient.lastName : ''}`;
    const doctorName = `Dr. ${appointment.doctor.firstName}${appointment.doctor.lastName ? ' ' + appointment.doctor.lastName : ''}`;
    const dateDisplay = appointment.appointmentDate.toISOString().split('T')[0];
    const slotDisplay = `${this.to12Hour(appointment.slot.startTime)} to ${this.to12Hour(appointment.slot.endTime)}`;
    const cancelledBy = role === Role.PATIENT ? 'Patient' : 'Doctor';

    // To Patient
    try {
      await this.emailService.sendAppointmentCancellation({
        to: appointment.patient.user.email,
        patientName,
        doctorName,
        date: dateDisplay,
        slotTime: slotDisplay,
        cancelledBy,
      });
    } catch (e) {
      console.error('Email to patient failed', e);
    }

    // To Doctor
    try {
      await this.emailService.sendAppointmentCancellation({
        to: appointment.doctor.user.email,
        patientName,
        doctorName,
        date: dateDisplay,
        slotTime: slotDisplay,
        cancelledBy,
      });
    } catch (e) {
      console.error('Email to doctor failed', e);
    }

    return {
      message: `Appointment cancelled successfully by ${cancelledBy.toLowerCase()}`,
      appointment: updatedAppointment,
    };
  }

  async updateAppointmentStatus(userId: string, appointmentId: string, status: AppointmentStatus) {
    if (status === AppointmentStatus.CANCELLED) {
      return this.cancelAppointment(userId, Role.DOCTOR, appointmentId);
    }

    const doctor = await this.prisma.doctor.findUnique({
      where: { userId },
    });
    if (!doctor) {
      throw new NotFoundException('Doctor profile not found');
    }

    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    if (appointment.doctorId !== doctor.id) {
      throw new BadRequestException('You are not authorized to update this appointment');
    }

    return this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { status },
    });
  }

  async rescheduleAppointment(userId: string, role: Role, appointmentId: string, dto: RescheduleAppointmentDto) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: { include: { user: true } },
        doctor: { include: { user: true } },
        slot: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Auth check
    if (role === Role.PATIENT) {
      if (appointment.patient.userId !== userId) {
        throw new BadRequestException('You are not authorized to reschedule this appointment');
      }
    } else if (role === Role.DOCTOR) {
      if (appointment.doctor.userId !== userId) {
        throw new BadRequestException('You are not authorized to reschedule this appointment');
      }
    }

    if (appointment.status !== AppointmentStatus.CONFIRMED) {
      throw new BadRequestException(`Cannot reschedule an appointment with status: ${appointment.status}`);
    }

    const { slotId, appointmentDate } = dto;
    const date = new Date(appointmentDate);
    if (isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD');
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const bookingDate = new Date(date);
    bookingDate.setUTCHours(0, 0, 0, 0);

    if (bookingDate < today) {
      throw new BadRequestException('Cannot reschedule to a past date');
    }

    // 1. Get New Slot info
    const newSlot = await this.prisma.availabilitySlot.findUnique({
      where: { id: slotId },
      include: { availability: true },
    });

    if (!newSlot) {
      throw new NotFoundException('New slot not found');
    }

    if (newSlot.availability.doctorId !== appointment.doctorId) {
      throw new BadRequestException('Cannot reschedule to a different doctor');
    }

    // 2. Validate date matches slot
    const availability = newSlot.availability;
    if (availability.date) {
      const slotDate = availability.date.toISOString().split('T')[0];
      const requestedDate = bookingDate.toISOString().split('T')[0];
      if (slotDate !== requestedDate) {
        throw new BadRequestException(`This slot is for ${slotDate}, but you requested ${requestedDate}.`);
      }
    } else {
      const requestedDayOfWeek = bookingDate.getUTCDay();
      if (availability.dayOfWeek !== null && availability.dayOfWeek !== requestedDayOfWeek) {
        const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        throw new BadRequestException(`This slot is for ${DAY_NAMES[availability.dayOfWeek]}, but ${appointmentDate} is a ${DAY_NAMES[requestedDayOfWeek]}.`);
      }
    }

    // 3. Capacity check for new slot
    const startOfDay = new Date(bookingDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(bookingDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const bookedCount = await this.prisma.appointment.count({
      where: {
        slotId: newSlot.id,
        appointmentDate: { gte: startOfDay, lte: endOfDay },
        status: { in: [AppointmentStatus.CONFIRMED] },
      },
    });

    if (bookedCount >= newSlot.maxAppt) {
      throw new BadRequestException(`The new slot is fully booked.`);
    }

    // 4. Check if patient already has an appointment for this slot on this date
    const existingAppointment = await this.prisma.appointment.findFirst({
      where: {
        patientId: appointment.patientId,
        slotId: newSlot.id,
        appointmentDate: startOfDay,
        id: { not: appointmentId }, // Exclude current appointment
        status: { in: [AppointmentStatus.CONFIRMED] },
      },
    });

    if (existingAppointment) {
      throw new BadRequestException('You already have another confirmed appointment for this slot on this date.');
    }

    // 5. Update Token and Appointment
    const newTokenNumber = bookedCount + 1;
    const oldDateStr = appointment.appointmentDate.toISOString().split('T')[0];
    const oldSlotTime = `${this.to12Hour(appointment.slot.startTime)} - ${this.to12Hour(appointment.slot.endTime)}`;

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        slotId: newSlot.id,
        appointmentDate: startOfDay,
        isRescheduled: true,
      },
    });

    // 5. Emails
    const patientName = `${appointment.patient.firstName}${appointment.patient.lastName ? ' ' + appointment.patient.lastName : ''}`;
    const doctorName = `Dr. ${appointment.doctor.firstName}${appointment.doctor.lastName ? ' ' + appointment.doctor.lastName : ''}`;
    const newDateStr = bookingDate.toISOString().split('T')[0];
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const newDayName = DAY_NAMES[bookingDate.getUTCDay()];
    const newSlotTime = `${this.to12Hour(newSlot.startTime)} to ${this.to12Hour(newSlot.endTime)}`;
    
    const newReportingTime = availability.scheduleType === 'WAVE'
      ? this.calculateReportingTime(newSlot.startTime, newSlot.endTime, newSlot.maxAppt, newTokenNumber)
      : this.to12Hour(newSlot.startTime);

    const emailData = {
      patientName,
      doctorName,
      oldDate: oldDateStr,
      oldSlotTime,
      newDate: newDateStr,
      newDay: newDayName,
      newSlotTime,
      newReportingTime,
      token: newTokenNumber,
      rescheduledBy: (role === Role.PATIENT ? 'Patient' : 'Doctor') as any,
    };

    try {
      await this.emailService.sendAppointmentReschedule({ to: appointment.patient.user.email, ...emailData });
      await this.emailService.sendAppointmentReschedule({ to: appointment.doctor.user.email, ...emailData });
    } catch (e) {
      console.error('Reschedule email failed', e);
    }

    return {
      message: 'Appointment rescheduled successfully',
      appointment: updated,
      newReportingTime,
      newToken: newTokenNumber
    };
  }
}
