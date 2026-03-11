import {
    Body,
    Controller,
    Get,
    Param,
    Patch,
    Post,
    UseGuards,
} from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role, AppointmentStatus } from '@prisma/client';
import { BookAppointmentDto } from './dto/book-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

@Controller('appointments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppointmentsController {
    constructor(private readonly appointmentsService: AppointmentsService) { }

    @Post('book')
    @Roles(Role.PATIENT)
    bookAppointment(
        @CurrentUser('userId') userId: string,
        @Body() dto: BookAppointmentDto,
    ) {
        return this.appointmentsService.bookAppointment(userId, dto);
    }

    @Get('me')
    @Roles(Role.PATIENT, Role.DOCTOR)
    getMyAppointments(@CurrentUser() user: any) {
        return this.appointmentsService.getMyAppointments(user.userId, user.role);
    }

    @Patch(':id/cancel')
    @Roles(Role.PATIENT, Role.DOCTOR)
    cancelAppointment(
        @CurrentUser() user: any,
        @Param('id') appointmentId: string,
    ) {
        return this.appointmentsService.cancelAppointment(user.userId, user.role, appointmentId);
    }

    @Patch(':id/reschedule')
    @Roles(Role.PATIENT, Role.DOCTOR)
    rescheduleAppointment(
        @CurrentUser() user: any,
        @Param('id') appointmentId: string,
        @Body() dto: RescheduleAppointmentDto,
    ) {
        return this.appointmentsService.rescheduleAppointment(user.userId, user.role, appointmentId, dto);
    }

    @Patch(':id/status')
    @Roles(Role.DOCTOR)
    updateStatus(
        @CurrentUser('userId') userId: string,
        @Param('id') appointmentId: string,
        @Body('status') status: AppointmentStatus,
    ) {
        return this.appointmentsService.updateAppointmentStatus(userId, appointmentId, status);
    }
}
