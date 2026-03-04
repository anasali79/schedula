import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { SigninDto } from './dto/signin.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { OnboardDoctorDto } from './dto/onboard-doctor.dto';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  COOKIE_NAMES,
  getAccessTokenCookieOptions,
  getRefreshTokenCookieOptions,
} from '../../common/constants/cookie';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) { }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie(COOKIE_NAMES.ACCESS_TOKEN, accessToken, getAccessTokenCookieOptions());
    res.cookie(COOKIE_NAMES.REFRESH_TOKEN, refreshToken, getRefreshTokenCookieOptions());
  }

  @Post('signup')
  async signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.signup(dto);
    this.setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken);
    return result;
  }

  @Get('verify-email')
  verifyEmailGet(@Query('token') token: string) {
    return this.auth.verifyEmail(token);
  }

  @Post('verify-email')
  verifyEmailPost(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @HttpCode(HttpStatus.OK)
  @Post('signin')
  async signin(@Body() dto: SigninDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.signin(dto);
    this.setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken);
    return result;
  }

  @Post('onboard/patient')
  @UseGuards(JwtAuthGuard)
  async onboardPatient(
    @CurrentUser('userId') userId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.assignPatientRole(userId);
    this.setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken);
    return result;
  }

  @Post('onboard/doctor')
  @UseGuards(JwtAuthGuard)
  async onboardDoctor(
    @CurrentUser('userId') userId: string,
    @Body() dto: OnboardDoctorDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.assignDoctorRole(userId, dto.firstName, dto.lastName);
    this.setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken);
    return result;
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleAuth() {
    // Redirects to Google
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  googleCallback(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = req.user as { tokens: { accessToken: string; refreshToken: string } };
    this.setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken);
    return result;
  }
}

