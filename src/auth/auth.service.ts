import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ActivityActorRole, ActivitySeverity, ActivityType, UserRole } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from './auth.types';
import { hashPassword, verifyPassword } from './passwords';
import { TokenService } from './token.service';

type LoginInput = { identifier: unknown; password: unknown };
type SignupInput = { registrationNumber: unknown; phone: unknown; password: unknown };
type VerifyOtpInput = { challengeId: unknown; code: unknown };

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly tokens: TokenService) {}

  async login(input: LoginInput) {
    const identifier = this.string(input.identifier, 'identifier').trim();
    const password = this.string(input.password, 'password');
    const normalized = identifier.toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: normalized }, { registrationNumber: identifier.toUpperCase() }] },
    });
    const settings = await this.settings();
    if (!user || !user.active || user.failedSignIns >= settings.maxFailedLogins || !(await verifyPassword(password, user.passwordHash))) {
      if (user) await this.prisma.user.update({ where: { id: user.id }, data: { failedSignIns: { increment: 1 } } });
      await this.activity({ actorId: user?.id, actorLabel: identifier, actorRole: user ? this.activityRole(user.role) : ActivityActorRole.ANONYMOUS, type: ActivityType.LOGIN_FAILED, severity: ActivitySeverity.WARNING, detail: 'Failed sign-in attempt.' });
      throw new UnauthorizedException('Sign-in details are invalid or the account is locked.');
    }

    if (user.role !== UserRole.SYSTEM_ADMINISTRATOR && (user.role === UserRole.STUDENT ? settings.studentOtpRequired : settings.officerOtpRequired)) {
      return this.startOtp(user.id, user.email);
    }
    return this.completeLogin(user.id);
  }

  async verifyOtp(input: VerifyOtpInput) {
    const challengeId = this.string(input.challengeId, 'challengeId');
    const code = this.string(input.code, 'code');
    const challenge = await this.prisma.oneTimeCodeChallenge.findFirst({
      where: { id: challengeId, consumedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!challenge || !(await verifyPassword(code, challenge.codeHash))) {
      throw new UnauthorizedException('The one-time code is invalid or has expired.');
    }
    const consumed = await this.prisma.oneTimeCodeChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new UnauthorizedException('The one-time code has already been used.');
    return this.completeLogin(challenge.userId);
  }

  async signup(input: SignupInput) {
    const registrationNumber = this.string(input.registrationNumber, 'registrationNumber').trim().toUpperCase();
    const phone = this.string(input.phone, 'phone').trim();
    const password = this.string(input.password, 'password');
    const settings = await this.settings();
    if (!settings.allowStudentSignup) throw new UnauthorizedException('Student sign-up is currently closed.');
    if (password.length < settings.passwordMinLength) throw new BadRequestException(`Password must contain at least ${settings.passwordMinLength} characters.`);

    const student = await this.prisma.registryRecord.findUnique({ where: { registrationNumber } });
    const today = new Date();
    if (!student || student.enrolment !== 'ACTIVE' || (student.registeredAcademicYear && student.registeredAcademicYear !== settings.academicYearLabel) || (student.studyEnd && student.studyEnd < today)) {
      await this.activity({ actorLabel: registrationNumber, actorRole: ActivityActorRole.ANONYMOUS, type: ActivityType.SIGNUP_BLOCKED, severity: ActivitySeverity.WARNING, detail: 'Student sign-up was refused by registry eligibility rules.' });
      throw new UnauthorizedException('This registration number is not eligible to create an account.');
    }
    if (settings.studentOtpRequired && process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('One-time code delivery must be configured before student sign-up is enabled in production.');
    if (await this.prisma.user.findFirst({ where: { registrationNumber } })) throw new BadRequestException('An account already exists for this registration number.');

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          role: UserRole.STUDENT,
          name: `${student.firstName} ${student.lastName}`.trim(),
          email: student.email?.toLowerCase() || null,
          registrationNumber,
          passwordHash: await hashPassword(password),
          studentProfile: {
            create: {
              registrationNumber,
              phone,
              createdForAcademicYear: settings.academicYearLabel,
            },
          },
        },
      });
      await tx.activityLog.create({
        data: { actorId: created.id, actorLabel: registrationNumber, actorRole: ActivityActorRole.STUDENT, type: ActivityType.SIGNUP, severity: ActivitySeverity.INFO, detail: 'Student account created after registry eligibility check.', beforeValue: 'No account', afterValue: 'Student account created' },
      });
      return created;
    });

    if (settings.studentOtpRequired) return this.startOtp(user.id, user.email);
    return this.completeLogin(user.id);
  }

  async me(user: AuthenticatedUser) {
    return { id: user.id, role: user.role, name: user.name, email: user.email, registrationNumber: user.registrationNumber };
  }

  async logout(user: AuthenticatedUser) {
    await this.activity({ actorId: user.id, actorLabel: user.registrationNumber ?? user.email ?? user.name, actorRole: this.activityRole(user.role), type: ActivityType.LOGOUT, severity: ActivitySeverity.INFO, detail: 'User signed out.' });
    return { success: true };
  }

  private async completeLogin(userId: string) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { failedSignIns: 0, lastLoginAt: new Date() } });
    await this.activity({ actorId: user.id, actorLabel: user.registrationNumber ?? user.email ?? user.name, actorRole: this.activityRole(user.role), type: ActivityType.LOGIN, severity: ActivitySeverity.INFO, detail: `Signed in as ${user.role}.` });
    return { ...this.tokens.issue(user.id, user.role), user: this.publicUser(user) };
  }

  private async startOtp(userId: string, email: string | null) {
    if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('One-time code delivery is not configured.');
    const code = String(randomInt(100_000, 1_000_000));
    const challenge = await this.prisma.oneTimeCodeChallenge.create({
      data: { userId, codeHash: await hashPassword(code), expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    return { requiresOtp: true, challengeId: challenge.id, expiresIn: 300, deliveryAddress: email, developmentCode: code };
  }

  private async settings() {
    return (await this.prisma.systemSettings.findUnique({ where: { id: 'default' } })) ?? {
      maxFailedLogins: 5,
      passwordMinLength: 10,
      allowStudentSignup: true,
      studentOtpRequired: true,
      officerOtpRequired: true,
      academicYearLabel: '2026/2027',
    };
  }

  private string(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
    return value;
  }

  private activityRole(role: UserRole): ActivityActorRole {
    if (role === UserRole.STUDENT) return ActivityActorRole.STUDENT;
    if (role === UserRole.ELECTION_OFFICER) return ActivityActorRole.ELECTION_OFFICER;
    if (role === UserRole.DISPUTE_RESOLUTION_COMMITTEE) return ActivityActorRole.DISPUTE_RESOLUTION_COMMITTEE;
    return ActivityActorRole.ADMINISTRATOR;
  }

  private publicUser(user: { id: string; role: UserRole; name: string; email: string | null; registrationNumber: string | null }) {
    return { id: user.id, role: user.role, name: user.name, email: user.email, registrationNumber: user.registrationNumber };
  }

  private async activity(input: {
    actorId?: string;
    actorLabel: string;
    actorRole: ActivityActorRole;
    type: ActivityType;
    severity: ActivitySeverity;
    detail: string;
    beforeValue?: string;
    afterValue?: string;
  }) {
    await this.prisma.activityLog.create({ data: input });
  }
}
