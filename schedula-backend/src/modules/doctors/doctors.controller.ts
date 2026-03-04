import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
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
} from './dto/set-availability.dto';

@Controller('doctors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.DOCTOR)
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) { }

  @Get('me')
  getMyProfile(@CurrentUser('userId') userId: string) {
    return this.doctorsService.getMyProfile(userId);
  }

  @Put('profile')
  updateProfile(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.doctorsService.updateProfile(userId, dto);
  }

  @Post('specialization')
  addSpecialization(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateSpecializationDto,
  ) {
    return this.doctorsService.addSpecialization(userId, dto);
  }

  // GET /api/v1/doctors/availability
  @Get('availability')
  getMyAvailability(@CurrentUser('userId') userId: string) {
    return this.doctorsService.getMyAvailability(userId);
  }

  // PUT /api/v1/doctors/availability/monday
  // Body: { "slots": [{ "startTime": "13:00", "endTime": "14:00" }] }
  @Put('availability/:day')
  setDayAvailability(
    @CurrentUser('userId') userId: string,
    @Param('day') day: string,
    @Body() dto: SetDaySlotsDto,
  ) {
    return this.doctorsService.setDayAvailability(userId, day, dto);
  }

  // PUT /api/v1/doctors/availability
  // Body: { "schedule": [{ "day": "monday", "slots": [...] }] }
  @Put('availability')
  setWeekAvailability(
    @CurrentUser('userId') userId: string,
    @Body() dto: SetWeekAvailabilityDto,
  ) {
    return this.doctorsService.setWeekAvailability(userId, dto);
  }

  // DELETE /api/v1/doctors/availability/monday
  @Delete('availability/:day')
  deleteDayAvailability(
    @CurrentUser('userId') userId: string,
    @Param('day') day: string,
  ) {
    return this.doctorsService.deleteDayAvailability(userId, day);
  }

  // DELETE /api/v1/doctors/availability/slot/:slotId
  @Delete('availability/slot/:slotId')
  deleteSlot(
    @CurrentUser('userId') userId: string,
    @Param('slotId') slotId: string,
  ) {
    return this.doctorsService.deleteSlot(userId, slotId);
  }
}
