import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ActivityActorRole,
  ActivitySeverity,
  ActivityType,
  UserRole,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from './auth.types';
import { hashPassword, verifyPassword } from './passwords';
import { TokenService } from './token.service';
import { NotificationsService } from '../notifications/notifications.service';

type LoginInput = { identifier: unknown; password: unknown };
type SignupInput = {
  registrationNumber: unknown;
  phone: unknown;
  password: unknown;
};
type VerifyOtpInput = { challengeId: unknown; code: unknown };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly notifications: NotificationsService,
  ) {}

  async login(input: LoginInput) {
    const identifier = this.string(input.identifier, 'identifier').trim();
    const password = this.string(input.password, 'password');
    const normalized = identifier.toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: normalized },
          { registrationNumber: identifier.toUpperCase() },
        ],
      },
    });
    const settings = await this.settings();
    if (
      !user ||
      !user.active ||
      user.failedSignIns >= settings.maxFailedLogins ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      if (user)
        await this.prisma.user.update({
          where: { id: user.id },
          data: { failedSignIns: { increment: 1 } },
        });
      await this.activity({
        actorId: user?.id,
        actorLabel: identifier,
        actorRole: user
          ? this.activityRole(user.role)
          : ActivityActorRole.ANONYMOUS,
        type: ActivityType.LOGIN_FAILED,
        severity: ActivitySeverity.WARNING,
        detail: 'Failed sign-in attempt.',
      });
      throw new UnauthorizedException(
        'Sign-in details are invalid or the account is locked.',
      );
    }

    if (
      user.role !== UserRole.SYSTEM_ADMINISTRATOR &&
      (user.role === UserRole.STUDENT
        ? settings.studentOtpRequired
        : settings.officerOtpRequired)
    ) {
      return this.startOtp(user.id, user.email);
    }
    return this.completeLogin(user.id);
  }

  async verifyOtp(input: VerifyOtpInput) {
    const challengeId = this.string(input.challengeId, 'challengeId');
    const code = this.string(input.code, 'code');
    const challenge = await this.prisma.oneTimeCodeChallenge.findFirst({
      where: {
        id: challengeId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!challenge || !(await verifyPassword(code, challenge.codeHash))) {
      throw new UnauthorizedException(
        'The one-time code is invalid or has expired.',
      );
    }
    const consumed = await this.prisma.oneTimeCodeChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1)
      throw new UnauthorizedException(
        'The one-time code has already been used.',
      );
    return this.completeLogin(challenge.userId);
  }

  async signup(input: SignupInput) {
    const registrationNumber = this.string(
      input.registrationNumber,
      'registrationNumber',
    )
      .trim()
      .toUpperCase();
    const phone = this.string(input.phone, 'phone').trim();
    const password = this.string(input.password, 'password');
    const settings = await this.settings();
    if (!settings.allowStudentSignup)
      throw new UnauthorizedException('Student sign-up is currently closed.');
    if (password.length < settings.passwordMinLength)
      throw new BadRequestException(
        `Password must contain at least ${settings.passwordMinLength} characters.`,
      );

    const student = await this.prisma.registryRecord.findUnique({
      where: { registrationNumber },
    });
    const today = new Date();
    if (
      !student ||
      student.enrolment !== 'ACTIVE' ||
      (student.registeredAcademicYear &&
        student.registeredAcademicYear !== settings.academicYearLabel) ||
      (student.studyEnd && student.studyEnd < today)
    ) {
      await this.activity({
        actorLabel: registrationNumber,
        actorRole: ActivityActorRole.ANONYMOUS,
        type: ActivityType.SIGNUP_BLOCKED,
        severity: ActivitySeverity.WARNING,
        detail: 'Student sign-up was refused by registry eligibility rules.',
      });
      throw new UnauthorizedException(
        'This registration number is not eligible to create an account.',
      );
    }
    if (settings.studentOtpRequired && process.env.NODE_ENV === 'production')
      throw new ServiceUnavailableException(
        'One-time code delivery must be configured before student sign-up is enabled in production.',
      );
    if (await this.prisma.user.findFirst({ where: { registrationNumber } }))
      throw new BadRequestException(
        'An account already exists for this registration number.',
      );

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
        data: {
          actorId: created.id,
          actorLabel: registrationNumber,
          actorRole: ActivityActorRole.STUDENT,
          type: ActivityType.SIGNUP,
          severity: ActivitySeverity.INFO,
          detail: 'Student account created after registry eligibility check.',
          beforeValue: 'No account',
          afterValue: 'Student account created',
        },
      });
      return created;
    });
    await this.notifications.toUser(user.id, {
      kind: 'account',
      title: 'Welcome to UniVote',
      body: 'Your student account is ready. Check the elections open to you and the candidates standing.',
      link: '/student',
    });

    if (settings.studentOtpRequired) return this.startOtp(user.id, user.email);
    return this.completeLogin(user.id);
  }

  // Public, first-time check. Returns the registry details a student needs to recognise their
  // own record (no contact details, date of birth, GPA or disciplinary data) and why they can or
  // cannot create an account.
  async checkStudentEligibility(registrationNumberValue: unknown) {
    const registrationNumber = this.string(
      registrationNumberValue,
      'registrationNumber',
    )
      .trim()
      .toUpperCase();
    const settings = await this.settings();
    const student = await this.prisma.registryRecord.findUnique({
      where: { registrationNumber },
    });
    if (!student)
      return {
        found: false,
        eligible: false,
        hasAccount: false,
        signupOpen: settings.allowStudentSignup,
        academicYear: settings.academicYearLabel,
        reasons: [
          'This registration number is not on the current student registry. Check it, or contact the registry office.',
        ],
        student: null,
      };
    const today = new Date();
    const reasons: string[] = [];
    if (student.enrolment !== 'ACTIVE')
      reasons.push(
        `Your registry status is ${student.enrolment.toLowerCase()}, not active.`,
      );
    if (
      student.registeredAcademicYear &&
      student.registeredAcademicYear !== settings.academicYearLabel
    )
      reasons.push(
        `You are registered for ${student.registeredAcademicYear}, not the current academic year ${settings.academicYearLabel}.`,
      );
    if (student.studyEnd && student.studyEnd < today)
      reasons.push('Your study period has ended.');
    const hasAccount = Boolean(
      await this.prisma.user.findFirst({ where: { registrationNumber } }),
    );
    if (!settings.allowStudentSignup && !hasAccount)
      reasons.push('Student sign-up is closed at the moment.');
    return {
      found: true,
      eligible: reasons.length === 0,
      hasAccount,
      signupOpen: settings.allowStudentSignup,
      academicYear: settings.academicYearLabel,
      reasons,
      student: {
        registrationNumber: student.registrationNumber,
        firstName: student.firstName,
        lastName: student.lastName,
        college: student.college,
        collegeCode: student.collegeCode,
        school: student.school,
        department: student.department,
        programme: student.programme,
        campus: student.campus,
        level: student.level,
        yearOfStudy: student.yearOfStudy,
        enrolment: student.enrolment,
        registeredAcademicYear: student.registeredAcademicYear,
        studyStart: student.studyStart,
        studyEnd: student.studyEnd,
        emailHint: student.email ? this.maskEmail(student.email) : null,
      },
    };
  }

  async refresh(refreshTokenValue: unknown) {
    const refreshToken = this.string(refreshTokenValue, 'refreshToken');
    const payload = this.tokens.verify(refreshToken, 'refresh');
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (
      !user ||
      !user.active ||
      user.role !== payload.role ||
      (payload.ver ?? 0) !== user.sessionVersion
    )
      throw new UnauthorizedException(
        'Your session has ended. Please sign in again.',
      );
    return { ...this.tokens.issue(user), user: this.publicUser(user) };
  }

  async impersonate(admin: AuthenticatedUser, targetId: string) {
    if (admin.role !== UserRole.SYSTEM_ADMINISTRATOR || admin.impersonatorId)
      throw new ForbiddenException(
        'Only a signed-in system administrator can open another account.',
      );
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
    });
    if (!target) throw new NotFoundException('User account was not found.');
    if (target.id === admin.id)
      throw new BadRequestException('You are already signed in as yourself.');
    if (target.role === UserRole.SYSTEM_ADMINISTRATOR)
      throw new ForbiddenException(
        'Administrators cannot sign in as another administrator.',
      );
    if (!target.active)
      throw new BadRequestException(
        'Reactivate this account before signing in as it.',
      );
    await this.activity({
      actorId: admin.id,
      actorLabel: admin.email ?? admin.name,
      actorRole: ActivityActorRole.ADMINISTRATOR,
      type: ActivityType.ACCOUNT,
      severity: ActivitySeverity.CRITICAL,
      detail: `Administrator signed in as ${target.registrationNumber ?? target.email ?? target.name} for support.`,
      beforeValue: admin.email ?? admin.name,
      afterValue: `${target.role}: ${target.registrationNumber ?? target.email ?? target.name}`,
    });
    await this.notifications.toUser(target.id, {
      kind: 'account',
      title: 'An administrator opened your account',
      body: `${admin.name} signed in to your account to help with a support request. Contact the election office if you did not expect this.`,
    });
    return {
      ...this.tokens.issue(target, { impersonatorId: admin.id }),
      user: this.publicUser(target),
      impersonator: { id: admin.id, name: admin.name, email: admin.email },
    };
  }

  async stopImpersonation(user: AuthenticatedUser) {
    if (!user.impersonatorId) return { success: true };
    const admin = await this.prisma.user.findUnique({
      where: { id: user.impersonatorId },
    });
    await this.activity({
      actorId: user.impersonatorId,
      actorLabel: admin?.email ?? admin?.name ?? 'administrator',
      actorRole: ActivityActorRole.ADMINISTRATOR,
      type: ActivityType.ACCOUNT,
      severity: ActivitySeverity.WARNING,
      detail: `Administrator left the account of ${user.registrationNumber ?? user.email ?? user.name}.`,
    });
    return { success: true };
  }

  me(user: AuthenticatedUser) {
    return {
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      registrationNumber: user.registrationNumber,
      impersonatorId: user.impersonatorId ?? null,
    };
  }

  async logout(user: AuthenticatedUser) {
    if (user.impersonatorId) return this.stopImpersonation(user);
    await this.activity({
      actorId: user.id,
      actorLabel: user.registrationNumber ?? user.email ?? user.name,
      actorRole: this.activityRole(user.role),
      type: ActivityType.LOGOUT,
      severity: ActivitySeverity.INFO,
      detail: 'User signed out.',
    });
    return { success: true };
  }

  private async completeLogin(userId: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { failedSignIns: 0, lastLoginAt: new Date() },
    });
    await this.activity({
      actorId: user.id,
      actorLabel: user.registrationNumber ?? user.email ?? user.name,
      actorRole: this.activityRole(user.role),
      type: ActivityType.LOGIN,
      severity: ActivitySeverity.INFO,
      detail: `Signed in as ${user.role}.`,
    });
    return {
      ...this.tokens.issue(user),
      user: this.publicUser(user),
    };
  }

  private async startOtp(userId: string, email: string | null) {
    if (process.env.NODE_ENV === 'production')
      throw new ServiceUnavailableException(
        'One-time code delivery is not configured.',
      );
    const code = String(randomInt(100_000, 1_000_000));
    const challenge = await this.prisma.oneTimeCodeChallenge.create({
      data: {
        userId,
        codeHash: await hashPassword(code),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    return {
      requiresOtp: true,
      challengeId: challenge.id,
      expiresIn: 300,
      deliveryAddress: email,
      developmentCode: code,
    };
  }

  private async settings() {
    return (
      (await this.prisma.systemSettings.findUnique({
        where: { id: 'default' },
      })) ?? {
        maxFailedLogins: 5,
        passwordMinLength: 10,
        allowStudentSignup: true,
        studentOtpRequired: true,
        officerOtpRequired: true,
        academicYearLabel: '2026/2027',
      }
    );
  }

  private maskEmail(email: string) {
    const [local, domain] = email.split('@');
    if (!domain) return null;
    return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }

  private string(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${field} is required.`);
    return value;
  }

  private activityRole(role: UserRole): ActivityActorRole {
    if (role === UserRole.STUDENT) return ActivityActorRole.STUDENT;
    if (role === UserRole.ELECTION_OFFICER)
      return ActivityActorRole.ELECTION_OFFICER;
    if (role === UserRole.DISPUTE_RESOLUTION_COMMITTEE)
      return ActivityActorRole.DISPUTE_RESOLUTION_COMMITTEE;
    return ActivityActorRole.ADMINISTRATOR;
  }

  private publicUser(user: {
    id: string;
    role: UserRole;
    name: string;
    email: string | null;
    registrationNumber: string | null;
  }) {
    return {
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      registrationNumber: user.registrationNumber,
    };
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
