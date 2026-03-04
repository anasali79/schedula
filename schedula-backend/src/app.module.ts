import { Module } from '@nestjs/common';
import { HelloController } from './hello.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { DoctorsModule } from './modules/doctors/doctors.module';

@Module({
  imports: [PrismaModule, AuthModule, DoctorsModule],
  controllers: [HelloController,],
  providers: [],
})
export class AppModule {}



