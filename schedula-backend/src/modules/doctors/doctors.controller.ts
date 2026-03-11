import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DoctorsService } from './doctors.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateSpecializationDto } from './dto/create-specialization.dto';
import {
  SetDaySlotsDto,
  SetWeekAvailabilityDto,
  SetCustomAvailabilityDto,
  GenerateWaveSlotsDto,
  UpdateWaveSlotsDto,
} from './dto/set-availability.dto';

@Controller('doctors')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) { }

  // --- DOCTOR ONLY (Profile & Availability Management) ---

  @Post('wave/generate-slots')
  @Roles(Role.DOCTOR)
  generateWaveSlotsPreview(@Body() dto: GenerateWaveSlotsDto) {
    return this.doctorsService.generateWaveSlotsPreview(dto);
  }

  @Put('availability/:id/update-slots')
  @Roles(Role.DOCTOR)
  updateWaveSlots(
    @CurrentUser('userId') userId: string,
    @Param('id') availabilityId: string,
    @Body() dto: UpdateWaveSlotsDto,
  ) {
    return this.doctorsService.updateWaveSlots(userId, availabilityId, dto);
  }

  @Get('me')
  @Roles(Role.DOCTOR)
  getMyProfile(@CurrentUser('userId') userId: string) {
    return this.doctorsService.getMyProfile(userId);
  }

  @Put('profile')
  @Roles(Role.DOCTOR)
  updateProfile(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.doctorsService.updateProfile(userId, dto);
  }

  @Post('specialization')
  @Roles(Role.DOCTOR)
  addSpecialization(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateSpecializationDto,
  ) {
    return this.doctorsService.addSpecialization(userId, dto);
  }

  @Get('me/availability') // For Doctor to view their own
  @Roles(Role.DOCTOR)
  getMyAvailability(
    @CurrentUser('userId') userId: string,
    @Query('date') date?: string,
  ) {
    return this.doctorsService.getMyAvailability(userId, date);
  }

  @Put('availability/:day')
  @Roles(Role.DOCTOR)
  setDayAvailability(
    @CurrentUser('userId') userId: string,
    @Param('day') day: string,
    @Body() dto: SetDaySlotsDto,
  ) {
    return this.doctorsService.setDayAvailability(userId, day, dto);
  }

  @Put('availability')
  @Roles(Role.DOCTOR)
  setWeekAvailability(
    @CurrentUser('userId') userId: string,
    @Body() dto: SetWeekAvailabilityDto,
  ) {
    return this.doctorsService.setWeekAvailability(userId, dto);
  }

  @Put('custom-availability/:date')
  @Roles(Role.DOCTOR)
  setCustomAvailability(
    @CurrentUser('userId') userId: string,
    @Param('date') date: string,
    @Body() dto: SetCustomAvailabilityDto,
  ) {
    return this.doctorsService.setCustomAvailability(userId, date, dto);
  }


  @Delete('availability/:day')
  @Roles(Role.DOCTOR)
  deleteDayAvailability(
    @CurrentUser('userId') userId: string,
    @Param('day') day: string,
  ) {
    return this.doctorsService.deleteDayAvailability(userId, day);
  }

  @Delete('custom-availability/:date')
  @Roles(Role.DOCTOR)
  deleteCustomAvailability(
    @CurrentUser('userId') userId: string,
    @Param('date') date: string,
  ) {
    return this.doctorsService.deleteCustomAvailability(userId, date);
  }

  @Delete('availability/slot/:slotId')
  @Roles(Role.DOCTOR)
  deleteSlot(
    @CurrentUser('userId') userId: string,
    @Param('slotId') slotId: string,
  ) {
    return this.doctorsService.deleteSlot(userId, slotId);
  }

  // --- PATIENT & DOCTOR ---

  @Get('list')
  @Roles(Role.PATIENT, Role.DOCTOR)
  listDoctors(@Query('specialization') specialization?: string) {
    return this.doctorsService.listDoctors(specialization);
  }

  @Get(':doctorId/availability')
  @Roles(Role.PATIENT, Role.DOCTOR)
  getDoctorAvailability(
    @Param('doctorId') doctorId: string,
    @Query('date') date?: string,
  ) {
    return this.doctorsService.getDoctorAvailability(doctorId, date);
  }
}
