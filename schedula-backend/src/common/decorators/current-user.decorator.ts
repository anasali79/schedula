import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type CurrentUserPayload = {
  userId: string;
  email: string;
  role: string | null;
};

export const CurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext): CurrentUserPayload | string | null => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as CurrentUserPayload;

    if (data) {
      return user?.[data] ?? null;
    }

    return user ?? null;
  },
);
