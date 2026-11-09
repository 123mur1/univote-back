import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivitySeverity,
  ActivityType,
  OfficerPermission,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get() {
    return this.ensureSettings();
  }

  async update(user: AuthenticatedUser, body: Record<string, unknown>) {
    const current = await this.ensureSettings();
    const data: Record<string, unknown> = {};
    const numbers = [
      'studentIdleMinutes',
      'officerIdleMinutes',
      'adminIdleMinutes',
      'warningSeconds',
      'passwordMinLength',
      'maxFailedLogins',
    ];
    for (const field of numbers) {
      if (body[field] !== undefined) {
        const value = Number(body[field]);
        if (!Number.isInteger(value) || value < 1 || value > 10_000)
          throw new BadRequestException(`${field} must be a positive integer.`);
        data[field] = value;
      }
    }
    for (const field of [
      'studentOtpRequired',
      'officerOtpRequired',
      'allowStudentSignup',
    ]) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== 'boolean')
          throw new BadRequestException(`${field} must be a boolean.`);
        data[field] = body[field];
      }
    }
    if (body.academicYearLabel !== undefined) {
      if (
        typeof body.academicYearLabel !== 'string' ||
        !/^\d{4}\/\d{4}$/.test(body.academicYearLabel)
      )
        throw new BadRequestException(
          'academicYearLabel must use YYYY/YYYY format.',
        );
      data.academicYearLabel = body.academicYearLabel;
    }
    for (const field of ['academicYearStart', 'academicYearEnd']) {
      if (body[field] !== undefined) {
        const date = new Date(String(body[field]));
        if (Number.isNaN(date.getTime()))
          throw new BadRequestException(`${field} must be a valid date.`);
        data[field] = date;
      }
    }
    const updated = await this.prisma.systemSettings.update({
      where: { id: 'default' },
      data,
    });
    await this.audit.activity(user, {
      type: ActivityType.SETTINGS,
      severity: ActivitySeverity.WARNING,
      detail: 'Updated system settings.',
      beforeValue: JSON.stringify(current),
      afterValue: JSON.stringify(updated),
    });
    return updated;
  }

  async listPermissions() {
    const rows = await this.prisma.rolePermission.findMany({
      where: { role: UserRole.ELECTION_OFFICER },
      orderBy: { permission: 'asc' },
    });
    return Object.values(OfficerPermission).map((permission) => ({
      permission,
      enabled:
        rows.find((row) => row.permission === permission)?.enabled ??
        permission !== OfficerPermission.EXPORT_VOTER_ROLL,
    }));
  }

  async setPermission(
    user: AuthenticatedUser,
    permissionValue: unknown,
    enabledValue: unknown,
  ) {
    if (
      typeof permissionValue !== 'string' ||
      !Object.values(OfficerPermission).includes(
        permissionValue as OfficerPermission,
      )
    )
      throw new BadRequestException('Unknown officer permission.');
    if (typeof enabledValue !== 'boolean')
      throw new BadRequestException('enabled must be a boolean.');
    const permission = permissionValue as OfficerPermission;
    const previous = await this.prisma.rolePermission.findFirst({
      where: { role: UserRole.ELECTION_OFFICER, permission },
    });
    const updated = await this.prisma.rolePermission.upsert({
      where: {
        role_permission: { role: UserRole.ELECTION_OFFICER, permission },
      },
      create: {
        role: UserRole.ELECTION_OFFICER,
        permission,
        enabled: enabledValue,
      },
      update: { enabled: enabledValue },
    });
    await this.audit.activity(user, {
      type: ActivityType.SETTINGS,
      severity: ActivitySeverity.WARNING,
      detail: `${enabledValue ? 'Granted' : 'Removed'} officer permission ${permission}.`,
      beforeValue: String(previous?.enabled ?? true),
      afterValue: String(enabledValue),
    });
    return updated;
  }

  private async ensureSettings() {
    const current = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
    });
    if (current) return current;
    return this.prisma.systemSettings.create({
      data: {
        id: 'default',
        academicYearLabel: '2026/2027',
        academicYearStart: new Date('2026-09-01T00:00:00.000Z'),
        academicYearEnd: new Date('2027-08-31T00:00:00.000Z'),
      },
    });
  }
}
