import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { DoctorsController } from './doctors.controller';
import { DoctorsService } from './doctors.service';

@Module({
  imports: [PrismaModule],
  controllers: [DoctorsController],
  providers: [DoctorsService],
})
export class DoctorsModule {}
