import { Controller, Post, Body, UseGuards, Patch } from '@nestjs/common';
import { ElasticSchedulingService } from './elastic-scheduling.service';
import { ExpandSessionDto, ShrinkSessionDto } from './dto/elastic.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('elastic')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ElasticSchedulingController {
  constructor(private readonly elasticService: ElasticSchedulingService) { }

  @Patch('session/expand')
  @Roles(Role.DOCTOR)
  expandSession(
    @CurrentUser('userId') userId: string,
    @Body() dto: ExpandSessionDto
  ) {
    return this.elasticService.expandSession(userId, dto);
  }

  @Patch('session/shrink')
  @Roles(Role.DOCTOR)
  shrinkSession(
    @CurrentUser('userId') userId: string,
    @Body() dto: ShrinkSessionDto
  ) {
    return this.elasticService.shrinkSession(userId, dto);
  }
}
