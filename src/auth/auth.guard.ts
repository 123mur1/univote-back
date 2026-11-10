import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, type User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithUser } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TokenService } from './token.service';

type CachedUser = {
  user: User;
  at: number;
};

// Every request re-checks that the account is still active. The database is remote, so the
// result is reused for a few seconds; account changes clear it immediately (forgetCachedUser).
const USER_CACHE_MS = 10_000;
const userCache = new Map<string, CachedUser>();

export function forgetCachedUser(id: string) {
  userCache.delete(id);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (isPublic) {
      // Public routes still learn who is asking when a valid token is sent, but never fail on it.
      if (scheme === 'Bearer' && token) {
        try {
          await this.authenticate(request, token);
        } catch {
          /* anonymous access */
        }
      }
      return true;
    }
    if (scheme !== 'Bearer' || !token)
      throw new UnauthorizedException('A bearer access token is required.');
    await this.authenticate(request, token);
    return true;
  }

  private async authenticate(request: RequestWithUser, token: string) {
    const payload = this.tokens.verify(token, 'access');
    const user = await this.loadUser(payload.sub);
    if (!user || !user.active || user.role !== payload.role)
      throw new UnauthorizedException('This account is not active.');
    if ((payload.ver ?? 0) !== user.sessionVersion)
      throw new UnauthorizedException(
        'This session was ended. Please sign in again.',
      );
    if (payload.imp) {
      const admin = await this.loadUser(payload.imp);
      if (
        !admin ||
        !admin.active ||
        admin.role !== UserRole.SYSTEM_ADMINISTRATOR
      )
        throw new UnauthorizedException(
          'The impersonation session is invalid.',
        );
    }
    request.user = {
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      registrationNumber: user.registrationNumber,
      ...(payload.imp ? { impersonatorId: payload.imp } : {}),
    };
  }

  private async loadUser(id: string) {
    const cached = userCache.get(id);
    if (cached && Date.now() - cached.at < USER_CACHE_MS) return cached.user;
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (user) userCache.set(id, { user, at: Date.now() });
    else userCache.delete(id);
    return user;
  }
}
