import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdatePatientDto } from './dto/update-patient.dto';

@Controller('patients')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PATIENT)
export class PatientsController {
    constructor(private readonly patientsService: PatientsService) { }

    @Get('me')
    getMyProfile(@CurrentUser('userId') userId: string) {
        return this.patientsService.getMyProfile(userId);
    }

    @Put('profile')
    updateProfile(
        @CurrentUser('userId') userId: string,
        @Body() dto: UpdatePatientDto,
    ) {
        return this.patientsService.updateProfile(userId, dto);
    }
}
