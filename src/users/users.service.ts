import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivitySeverity,
  ActivityType,
  UserRole,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { hashPassword } from '../auth/passwords';
import { forgetCachedUser } from '../auth/auth.guard';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async myRegistry(user: AuthenticatedUser) {
    if (user.role !== UserRole.STUDENT || !user.registrationNumber)
      throw new ForbiddenException('A student account is required.');
    const record = await this.prisma.registryRecord.findUnique({
      where: { registrationNumber: user.registrationNumber },
    });
    if (!record) throw new NotFoundException('Student is not in the registry.');
    return record;
  }

  async listStudents(query: { q?: string; page?: string; pageSize?: string }) {
    const page = this.int(query.page, 1, 1, 100_000);
    const pageSize = this.int(query.pageSize, 50, 1, 200);
    const q = query.q?.trim();
    const where = {
      role: UserRole.STUDENT,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
              {
                registrationNumber: {
                  contains: q.toUpperCase(),
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          role: true,
          name: true,
          email: true,
          registrationNumber: true,
          active: true,
          failedSignIns: true,
          lastLoginAt: true,
          createdAt: true,
          studentProfile: true,
        },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, page, pageSize, total };
  }

  listStaff() {
    return this.prisma.user.findMany({
      where: {
        role: {
          in: [
            UserRole.ELECTION_OFFICER,
            UserRole.DISPUTE_RESOLUTION_COMMITTEE,
            UserRole.SYSTEM_ADMINISTRATOR,
          ],
        },
      },
      select: {
        id: true,
        role: true,
        name: true,
        email: true,
        active: true,
        failedSignIns: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async createStudent(
    admin: AuthenticatedUser,
    body: { registrationNumber?: unknown; phone?: unknown; password?: unknown },
  ) {
    const registrationNumber = this.required(
      body.registrationNumber,
      'registrationNumber',
    ).toUpperCase();
    const phone = this.required(body.phone, 'phone');
    const password = this.required(body.password, 'password');
    const settings = await this.settings();
    if (password.length < settings.passwordMinLength)
      throw new BadRequestException(
        `Password must contain at least ${settings.passwordMinLength} characters.`,
      );
    const record = await this.prisma.registryRecord.findUnique({
      where: { registrationNumber },
    });
    if (
      !record ||
      record.enrolment !== 'ACTIVE' ||
      (record.registeredAcademicYear &&
        record.registeredAcademicYear !== settings.academicYearLabel) ||
      (record.studyEnd && record.studyEnd < new Date())
    ) {
      throw new BadRequestException(
        'Student does not meet current registry eligibility rules.',
      );
    }
    if (await this.prisma.user.findFirst({ where: { registrationNumber } }))
      throw new ConflictException(
        'An account already exists for this registration number.',
      );
    try {
      const user = await this.prisma.user.create({
        data: {
          role: UserRole.STUDENT,
          name: `${record.firstName} ${record.lastName}`.trim(),
          email: record.email?.toLowerCase() || null,
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
        select: {
          id: true,
          name: true,
          email: true,
          registrationNumber: true,
          role: true,
          active: true,
          createdAt: true,
        },
      });
      await this.audit.activity(admin, {
        type: ActivityType.ACCOUNT,
        detail: `Created student account for ${registrationNumber}.`,
        beforeValue: 'No account',
        afterValue: `${user.name}; ${user.email ?? 'email not set'}; active`,
      });
      return user;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'An account already uses this email or registration number.',
        );
      throw error;
    }
  }

  async createStaff(
    admin: AuthenticatedUser,
    body: {
      name?: unknown;
      email?: unknown;
      password?: unknown;
      role?: unknown;
    },
  ) {
    const name = this.required(body.name, 'name');
    const email = this.required(body.email, 'email').toLowerCase();
    const password = this.required(body.password, 'password');
    const role =
      body.role === 'SYSTEM_ADMINISTRATOR'
        ? UserRole.SYSTEM_ADMINISTRATOR
        : body.role === 'ELECTION_OFFICER'
          ? UserRole.ELECTION_OFFICER
          : body.role === 'DISPUTE_RESOLUTION_COMMITTEE'
            ? UserRole.DISPUTE_RESOLUTION_COMMITTEE
            : null;
    if (!role)
      throw new BadRequestException(
        'role must be ELECTION_OFFICER, DISPUTE_RESOLUTION_COMMITTEE or SYSTEM_ADMINISTRATOR.',
      );
    const settings = await this.settings();
    if (password.length < settings.passwordMinLength)
      throw new BadRequestException(
        `Password must contain at least ${settings.passwordMinLength} characters.`,
      );
    try {
      const user = await this.prisma.user.create({
        data: { name, email, role, passwordHash: await hashPassword(password) },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
          createdAt: true,
        },
      });
      await this.audit.activity(admin, {
        type: ActivityType.ACCOUNT,
        detail: `Created ${role} account for ${email}.`,
        beforeValue: 'No account',
        afterValue: `${role}; ${name}; active`,
      });
      await this.notifications.toUser(user.id, {
        kind: 'account',
        title: 'Welcome to UniVote',
        body: `${admin.name} created your ${role === UserRole.SYSTEM_ADMINISTRATOR ? 'administrator' : 'election officer'} account.`,
      });
      return user;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('A user account already uses that email.');
      throw error;
    }
  }

  async updateCredentials(
    admin: AuthenticatedUser,
    id: string,
    body: { email?: unknown; password?: unknown },
  ) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User account was not found.');
    const data: { email?: string | null; passwordHash?: string } = {};
    if (body.email !== undefined) {
      if (body.email !== null && typeof body.email !== 'string')
        throw new BadRequestException('email must be a string or null.');
      data.email =
        typeof body.email === 'string' && body.email.trim()
          ? body.email.trim().toLowerCase()
          : null;
    }
    if (body.password !== undefined) {
      const password = this.required(body.password, 'password');
      const settings = await this.settings();
      if (password.length < settings.passwordMinLength)
        throw new BadRequestException(
          `Password must contain at least ${settings.passwordMinLength} characters.`,
        );
      data.passwordHash = await hashPassword(password);
    }
    if (!Object.keys(data).length)
      throw new BadRequestException('Provide an email or password to update.');
    try {
      const updated = await this.prisma.user.update({
        where: { id },
        data: {
          ...data,
          ...(body.password !== undefined
            ? { failedSignIns: 0, sessionVersion: { increment: 1 } }
            : {}),
        },
        select: {
          id: true,
          name: true,
          email: true,
          registrationNumber: true,
          role: true,
          active: true,
          updatedAt: true,
        },
      });
      forgetCachedUser(id);

      await this.audit.activity(admin, {
        type: ActivityType.ACCOUNT,
        severity: ActivitySeverity.WARNING,
        detail: `Updated credentials for ${target.registrationNumber ?? target.email ?? target.name}.`,
        beforeValue: `Email: ${target.email ?? 'not set'}; password: unchanged`,
        afterValue: `Email: ${updated.email ?? 'not set'}; password: ${body.password ? 'reset' : 'unchanged'}`,
      });
      return updated;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'That email is already used by another account.',
        );
      throw error;
    }
  }

  async setActive(admin: AuthenticatedUser, id: string, activeValue: unknown) {
    if (typeof activeValue !== 'boolean')
      throw new BadRequestException('active must be a boolean.');
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User account was not found.');
    if (!activeValue && target.id === admin.id)
      throw new ForbiddenException('You cannot suspend your own account.');
    if (!activeValue && target.role === UserRole.SYSTEM_ADMINISTRATOR) {
      const activeAdmins = await this.prisma.user.count({
        where: { role: UserRole.SYSTEM_ADMINISTRATOR, active: true },
      });
      if (activeAdmins <= 1)
        throw new BadRequestException(
          'The last active administrator cannot be suspended.',
        );
    }
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        active: activeValue,
        ...(activeValue ? {} : { sessionVersion: { increment: 1 } }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        registrationNumber: true,
        role: true,
        active: true,
      },
    });
    forgetCachedUser(id);

    await this.audit.activity(admin, {
      type: ActivityType.ACCOUNT,
      severity: ActivitySeverity.WARNING,
      detail: `${activeValue ? 'Reactivated' : 'Suspended'} account ${target.registrationNumber ?? target.email ?? target.name}.`,
      beforeValue: String(target.active),
      afterValue: String(activeValue),
    });
    return updated;
  }

  async unlock(admin: AuthenticatedUser, id: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User account was not found.');
    const updated = await this.prisma.user.update({
      where: { id },
      data: { failedSignIns: 0 },
      select: {
        id: true,
        registrationNumber: true,
        email: true,
        failedSignIns: true,
      },
    });
    forgetCachedUser(id);

    await this.audit.activity(admin, {
      type: ActivityType.ACCOUNT,
      detail: `Unlocked account ${target.registrationNumber ?? target.email ?? target.name}.`,
      beforeValue: String(target.failedSignIns),
      afterValue: '0',
    });
    return updated;
  }

  async revokeSessions(admin: AuthenticatedUser, id: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User account was not found.');
    if (target.id === admin.id)
      throw new BadRequestException(
        'Sign out instead of revoking your own sessions.',
      );
    await this.prisma.user.update({
      where: { id },
      data: { sessionVersion: { increment: 1 } },
    });
    forgetCachedUser(id);
    await this.audit.activity(admin, {
      type: ActivityType.ACCOUNT,
      severity: ActivitySeverity.WARNING,
      detail: `Signed out every session of ${target.registrationNumber ?? target.email ?? target.name}.`,
    });
    return { success: true };
  }

  // Every account in one list for the administrator, with search, role and status filters.
  async listAll(query: {
    q?: string;
    role?: string;
    status?: string;
    page?: string;
    pageSize?: string;
  }) {
    const page = this.int(query.page, 1, 1, 100_000);
    const pageSize = this.int(query.pageSize, 25, 1, 200);
    const q = query.q?.trim();
    const role = Object.values(UserRole).find(
      (value) => value === query.role?.toUpperCase(),
    );
    const settings = await this.settings();
    const maxFailed =
      'maxFailedLogins' in settings ? Number(settings.maxFailedLogins) : 5;
    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(query.status === 'active' ? { active: true } : {}),
      ...(query.status === 'suspended' ? { active: false } : {}),
      ...(query.status === 'locked'
        ? { failedSignIns: { gte: maxFailed } }
        : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { registrationNumber: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          role: true,
          name: true,
          email: true,
          registrationNumber: true,
          active: true,
          failedSignIns: true,
          lastLoginAt: true,
          createdAt: true,
          studentProfile: { select: { phone: true } },
        },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, page, pageSize, total, maxFailedLogins: maxFailed };
  }

  private async settings() {
    return (
      (await this.prisma.systemSettings.findUnique({
        where: { id: 'default' },
      })) ?? { passwordMinLength: 10, academicYearLabel: '2026/2027' }
    );
  }

  private required(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${field} is required.`);
    return value.trim();
  }

  private int(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ) {
    if (!value) return fallback;
    const result = Number(value);
    if (!Number.isInteger(result) || result < min || result > max)
      throw new BadRequestException(
        `Expected an integer between ${min} and ${max}.`,
      );
    return result;
  }
}
