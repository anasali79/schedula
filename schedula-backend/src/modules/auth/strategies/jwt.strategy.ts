import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { COOKIE_NAMES } from '../../../common/constants/cookie';

export type JwtPayload = {
  sub: string;
  role: Role | null;
  email: string;
};

const extractFromCookieOrHeader = (req: Request): string | null => {
  const token = req?.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];
  if (token) return token;
  return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) throw new Error('JWT_ACCESS_SECRET is not set');
    super({
      jwtFromRequest: extractFromCookieOrHeader,
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: JwtPayload) {
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
    };
  }
}
