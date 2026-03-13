import { Module } from '@nestjs/common';
import { ElasticSchedulingController } from './elastic-scheduling.controller';
import { ElasticSchedulingService } from './elastic-scheduling.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ElasticSchedulingController],
  providers: [ElasticSchedulingService],
  exports: [ElasticSchedulingService],
})
export class ElasticSchedulingModule {}
