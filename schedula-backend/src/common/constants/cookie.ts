export const COOKIE_NAMES = {
  ACCESS_TOKEN: 'accessToken',
  REFRESH_TOKEN: 'refreshToken',
} as const;

const isProd = process.env.NODE_ENV === 'production';

export const getAccessTokenCookieOptions = () => ({
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax' as const,
  maxAge: 15 * 60 * 1000, // 15 min
  path: '/',
});

export const getRefreshTokenCookieOptions = () => ({
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/',
});
