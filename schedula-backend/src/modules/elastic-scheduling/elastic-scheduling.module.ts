import { Module } from '@nestjs/common';
import { ElasticSchedulingController } from './elastic-scheduling.controller';
import { ElasticSchedulingService } from './elastic-scheduling.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [ElasticSchedulingController],
  providers: [ElasticSchedulingService],
  exports: [ElasticSchedulingService],
})
export class ElasticSchedulingModule {}
