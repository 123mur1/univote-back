import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, RequestWithUser } from './auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest<RequestWithUser>().user,
);
