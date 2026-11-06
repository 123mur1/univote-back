import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithUser } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TokenService } from './token.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokenService, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('A bearer access token is required.');
    const payload = this.tokens.verify(token);
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active || user.role !== payload.role) throw new UnauthorizedException('This account is not active.');
    request.user = { id: user.id, role: user.role, name: user.name, email: user.email, registrationNumber: user.registrationNumber };
    return true;
  }
}
