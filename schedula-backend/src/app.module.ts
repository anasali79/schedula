import { Module } from '@nestjs/common';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { DoctorsModule } from './modules/doctors/doctors.module';
import { PatientsModule } from './modules/patients/patients.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { ElasticSchedulingModule } from './modules/elastic-scheduling/elastic-scheduling.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    DoctorsModule,
    PatientsModule,
    AppointmentsModule,
    ElasticSchedulingModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule { }