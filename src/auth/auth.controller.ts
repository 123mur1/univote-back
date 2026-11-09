import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ActivityActorRole,
  ActivitySeverity,
  ActivityType,
} from '@prisma/client';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import type { AuthenticatedUser } from './auth.types';
import { Public } from './public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from './passwords';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('login')
  login(@Body() body: { identifier: unknown; password: unknown }) {
    return this.auth.login(body);
  }

  @Public()
  @Post('otp/verify')
  verifyOtp(@Body() body: { challengeId: unknown; code: unknown }) {
    return this.auth.verifyOtp(body);
  }

  @Public()
  @Post('students/signup')
  signup(
    @Body()
    body: {
      registrationNumber: unknown;
      phone: unknown;
      password: unknown;
    },
  ) {
    return this.auth.signup(body);
  }

  @Public()
  @Post('students/eligibility')
  checkStudentEligibility(@Body() body: { registrationNumber: unknown }) {
    return this.auth.checkStudentEligibility(body.registrationNumber);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user);
  }

  @Post('logout')
  logout(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.logout(user);
  }

  @Public()
  @Post('bootstrap-admin')
  async bootstrapAdmin(@Body() body: { setupKey?: string }) {
    const expectedKey = process.env.ADMIN_BOOTSTRAP_KEY;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
    if (!expectedKey || body.setupKey !== expectedKey || !password || !email)
      return { success: false, message: 'Admin bootstrap is not configured.' };
    const existing = await this.prisma.user.findFirst({
      where: { role: 'SYSTEM_ADMINISTRATOR' },
    });
    if (existing)
      return {
        success: false,
        message: 'An administrator account already exists.',
      };
    const user = await this.prisma.user.create({
      data: {
        name: process.env.BOOTSTRAP_ADMIN_NAME ?? 'System Administrator',
        email,
        role: 'SYSTEM_ADMINISTRATOR',
        passwordHash: await hashPassword(password),
      },
    });
    await this.prisma.activityLog.create({
      data: {
        actorId: user.id,
        actorLabel: user.email ?? user.name,
        actorRole: ActivityActorRole.ADMINISTRATOR,
        type: ActivityType.ACCOUNT,
        severity: ActivitySeverity.WARNING,
        detail: 'Initial system administrator account created.',
        beforeValue: 'No administrator account',
        afterValue: 'System administrator account created',
      },
    });
    return { success: true, message: 'Administrator account created.' };
  }
}
