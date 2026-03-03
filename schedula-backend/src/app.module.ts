import { Module } from '@nestjs/common';
import { HelloController } from './hello.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [HelloController,],
  providers: [],
})
export class AppModule {}



