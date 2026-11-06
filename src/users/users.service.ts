import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivitySeverity, ActivityType, UserRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { hashPassword } from '../auth/passwords';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async listStudents(query: { q?: string; page?: string; pageSize?: string }) {
    const page = this.int(query.page, 1, 1, 100_000);
    const pageSize = this.int(query.pageSize, 50, 1, 200);
    const q = query.q?.trim();
    const where = {
      role: UserRole.STUDENT,
      ...(q ? { OR: [
        { name: { contains: q, mode: 'insensitive' as const } },
        { email: { contains: q, mode: 'insensitive' as const } },
        { registrationNumber: { contains: q.toUpperCase(), mode: 'insensitive' as const } },
      ] } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: { id: true, role: true, name: true, email: true, registrationNumber: true, active: true, failedSignIns: true, lastLoginAt: true, createdAt: true, studentProfile: true }, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.user.count({ where }),
    ]);
    return { items, page, pageSize, total };
  }

  async createStudent(admin: AuthenticatedUser, body: { registrationNumber?: unknown; phone?: unknown; password?: unknown }) {
    const registrationNumber = this.required(body.registrationNumber, 'registrationNumber').toUpperCase();
    const phone = this.required(body.phone, 'phone');
    const password = this.required(body.password, 'password');
    const settings = await this.settings();
    if (password.length < settings.passwordMinLength) throw new BadRequestException(`Password must contain at least ${settings.passwordMinLength} characters.`);
    const record = await this.prisma.registryRecord.findUnique({ where: { registrationNumber } });
    if (!record || record.enrolment !== 'ACTIVE' || (record.registeredAcademicYear && record.registeredAcademicYear !== settings.academicYearLabel) || (record.studyEnd && record.studyEnd < new Date())) {
      throw new BadRequestException('Student does not meet current registry eligibility rules.');
    }
    if (await this.prisma.user.findFirst({ where: { registrationNumber } })) throw new ConflictException('An account already exists for this registration number.');
    try {
      const user = await this.prisma.user.create({
        data: {
          role: UserRole.STUDENT,
          name: `${record.firstName} ${record.lastName}`.trim(),
          email: record.email?.toLowerCase() || null,
          registrationNumber,
          passwordHash: await hashPassword(password),
          studentProfile: { create: { registrationNumber, phone, createdForAcademicYear: settings.academicYearLabel } },
        },
        select: { id: true, name: true, email: true, registrationNumber: true, role: true, active: true, createdAt: true },
      });
      await this.audit.activity(admin, { type: ActivityType.ACCOUNT, detail: `Created student account for ${registrationNumber}.`, beforeValue: 'No account', afterValue: `${user.name}; ${user.email ?? 'email not set'}; active` });
      return user;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('An account already uses this email or registration number.');
      throw error;
    }
  }

  async createStaff(admin: AuthenticatedUser, body: { name?: unknown; email?: unknown; password?: unknown; role?: unknown }) {
    const name = this.required(body.name, 'name');
    const email = this.required(body.email, 'email').toLowerCase();
    const password = this.required(body.password, 'password');
    const role = body.role === 'SYSTEM_ADMINISTRATOR' ? UserRole.SYSTEM_ADMINISTRATOR : body.role === 'ELECTION_OFFICER' ? UserRole.ELECTION_OFFICER : null;
    if (!role) throw new BadRequestException('role must be ELECTION_OFFICER or SYSTEM_ADMINISTRATOR.');
    const settings = await this.settings();
    if (password.length < settings.passwordMinLength) throw new BadRequestException(`Password must contain at least ${settings.passwordMinLength} characters.`);
    try {
      const user = await this.prisma.user.create({ data: { name, email, role, passwordHash: await hashPassword(password) }, select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } });
      await this.audit.activity(admin, { type: ActivityType.ACCOUNT, detail: `Created ${role} account for ${email}.`, beforeValue: 'No account', afterValue: `${role}; ${name}; active` });
      return user;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('A user account already uses that email.');
      throw error;
    }
  }

  async updateCredentials(admin: AuthenticatedUser, id: string, body: { email?: unknown; password?: unknown }) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User account was not found.');
    const data: { email?: string | null; passwordHash?: string } = {};
    if (body.email !== undefined) {
      if (body.email !== null && typeof body.email !== 'string') throw new BadRequestException('email must be a string or null.');
      data.email = typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null;
    }
    if (body.password !== undefined) {
      const password = this.required(body.password, 'password');
      const settings = await this.settings();
      if (password.length < settings.passwordMinLength) throw new BadRequestException(`Password must contain at least ${settings.passwordMinLength} characters.`);
      data.passwordHash = await hashPassword(password);
    }
    if (!Object.keys(data).length) throw new BadRequestException('Provide an email or password to update.');
    try {
      const updated = await this.prisma.user.update({ where: { id }, data: { ...data, ...(body.password !== undefined ? { failedSignIns: 0 } : {}) }, select: { id: true, name: true, email: true, registrationNumber: true, role: true, active: true, updatedAt: true } });
      await this.audit.activity(admin, { type: ActivityType.ACCOUNT, severity: ActivitySeverity.WARNING, detail: `Updated credentials for ${target.registrationNumber ?? target.email ?? target.name}.`, beforeValue: `Email: ${target.email ?? 'not set'}; password: unchanged`, afterValue: `Email: ${updated.email ?? 'not set'}; password: ${body.password ? 'reset' : 'unchanged'}` });
      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('That email is already used by another account.');
      throw error;
    }
  }

  async setActive(admin: AuthenticatedUser, id: string, activeValue: unknown) {
    if (typeof activeValue !== 'boolean') throw new BadRequestException('active must be a boolean.');
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User account was not found.');
    if (!activeValue && target.id === admin.id) throw new ForbiddenException('You cannot suspend your own account.');
    if (!activeValue && target.role === UserRole.SYSTEM_ADMINISTRATOR) {
      const activeAdmins = await this.prisma.user.count({ where: { role: UserRole.SYSTEM_ADMINISTRATOR, active: true } });
      if (activeAdmins <= 1) throw new BadRequestException('The last active administrator cannot be suspended.');
    }
    const updated = await this.prisma.user.update({ where: { id }, data: { active: activeValue }, select: { id: true, name: true, email: true, registrationNumber: true, role: true, active: true } });
    await this.audit.activity(admin, { type: ActivityType.ACCOUNT, severity: ActivitySeverity.WARNING, detail: `${activeValue ? 'Reactivated' : 'Suspended'} account ${target.registrationNumber ?? target.email ?? target.name}.`, beforeValue: String(target.active), afterValue: String(activeValue) });
    return updated;
  }

  async unlock(admin: AuthenticatedUser, id: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User account was not found.');
    const updated = await this.prisma.user.update({ where: { id }, data: { failedSignIns: 0 }, select: { id: true, registrationNumber: true, email: true, failedSignIns: true } });
    await this.audit.activity(admin, { type: ActivityType.ACCOUNT, detail: `Unlocked account ${target.registrationNumber ?? target.email ?? target.name}.`, beforeValue: String(target.failedSignIns), afterValue: '0' });
    return updated;
  }

  private async settings() {
    return (await this.prisma.systemSettings.findUnique({ where: { id: 'default' } })) ?? { passwordMinLength: 10, academicYearLabel: '2026/2027' };
  }

  private required(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
    return value.trim();
  }

  private int(value: string | undefined, fallback: number, min: number, max: number) {
    if (!value) return fallback;
    const result = Number(value);
    if (!Number.isInteger(result) || result < min || result > max) throw new BadRequestException(`Expected an integer between ${min} and ${max}.`);
    return result;
  }
}
