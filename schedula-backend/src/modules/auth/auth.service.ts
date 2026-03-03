import {ConflictException, Injectable,UnauthorizedException,BadRequestException,} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider, Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { SignupDto } from './dto/signup.dto';
import { SigninDto } from './dto/signin.dto';
import { Profile } from 'passport-google-oauth20';

type JwtPayload = {
  sub: string;
  role: Role | null;
  email: string;
};

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  // Token Generator

  private async generateTokens(user: User) {
    const payload: JwtPayload = {
      sub: user.id,
      role: user.role ?? null,
      email: user.email,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: mustGetEnv('JWT_ACCESS_SECRET'),
      expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
    });

    const refreshToken = await this.jwt.signAsync(payload, {
      secret: mustGetEnv('JWT_REFRESH_SECRET'),
      expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
    });

    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash },
    });

    return { accessToken, refreshToken };
  }


  // Email Signup
 

  async signup(dto: SignupDto) {
    const passwordHash = await bcrypt.hash(dto.password, 10);

    try {
      const user = await this.prisma.user.create({
        data: {
          email: dto.email.toLowerCase(),
          passwordHash,
          provider: AuthProvider.LOCAL,
        },
      });

      const tokens = await this.generateTokens(user);

      return {
        message: 'Signup successful',
        user: this.sanitizeUser(user),
        tokens,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email already exists');
      }
      throw error;
    }
  }

  // Email Signin

  async signin(dto: SigninDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatch = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user);

    return {
      message: 'Signin successful',
      user: this.sanitizeUser(user),
      tokens,
    };
  }

  // Google OAuth

  async handleGoogleProfile(profile: Profile) {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    const googleId = profile.id;

    if (!email) {
      throw new UnauthorizedException('Google account has no email');
    }

    let user = await this.prisma.user.findFirst({
      where: {
        OR: [{ googleId }, { email }],
      },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          googleId,
          provider: AuthProvider.GOOGLE,
          isVerified: true,
        },
      });
    } else if (!user.googleId) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          googleId,
          provider: AuthProvider.GOOGLE,
        },
      });
    }

    const tokens = await this.generateTokens(user);

    return {
      message: 'Google login successful',
      user: this.sanitizeUser(user),
      tokens,
    };
  }

  // Patient Onboarding


  async assignPatientRole(userId: string) {
    const existingUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!existingUser) {
      throw new UnauthorizedException('User not found');
    }

    if (existingUser.role) {
      throw new ConflictException('Role already assigned');
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { role: Role.PATIENT },
    });

    return {
      message: 'Patient onboarding successful',
      user: this.sanitizeUser(user),
    };
  }

  // Doctor Onboarding

  async assignDoctorRole(userId: string) {
    const existingUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!existingUser) {
      throw new UnauthorizedException('User not found');
    }

    if (existingUser.role) {
      throw new ConflictException('Role already assigned');
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { role: Role.DOCTOR },
    });

    return {
      message: 'Doctor onboarding successful',
      user: this.sanitizeUser(user),
    };
  }

  // Helper

  private sanitizeUser(user: User) {
    const { passwordHash, refreshTokenHash, ...safeUser } = user;
    return safeUser;
  }
}