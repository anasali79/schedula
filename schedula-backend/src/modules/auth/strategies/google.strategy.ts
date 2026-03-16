import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy, StrategyOptions } from 'passport-google-oauth20';
import { AuthService } from '../auth.service';

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private readonly authService: AuthService) {
    const options: StrategyOptions = {
      clientID: mustGetEnv('GOOGLE_CLIENT_ID'),
      clientSecret: mustGetEnv('GOOGLE_CLIENT_SECRET'),
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL ||
        'http://localhost:3000/api/v1/auth/google/callback',
      scope: ['email', 'profile'],
    };

    super(options);
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<any> {
    return this.authService.handleGoogleProfile(profile);
  }
}