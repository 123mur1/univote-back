import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityActorRole,
  ActivitySeverity,
  ActivityType,
  EnrolmentStatus,
  Gender,
  Prisma,
  StudyLevel,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

type ImportRow = Record<string, unknown>;

@Injectable()
export class RegistryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    user: AuthenticatedUser,
    query: {
      q?: string;
      campus?: string;
      college?: string;
      school?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    await this.requireViewPermission(user);
    const page = this.number(query.page, 1, 1, 100_000);
    const pageSize = this.number(query.pageSize, 50, 1, 200);
    const where = {
      ...(query.q
        ? {
            OR: [
              {
                registrationNumber: {
                  contains: query.q.trim(),
                  mode: 'insensitive' as const,
                },
              },
              {
                firstName: {
                  contains: query.q.trim(),
                  mode: 'insensitive' as const,
                },
              },
              {
                lastName: {
                  contains: query.q.trim(),
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
      ...(query.campus ? { campus: query.campus } : {}),
      ...(query.college ? { college: query.college } : {}),
      ...(query.school ? { school: query.school } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.registryRecord.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.registryRecord.count({ where }),
    ]);
    return { items, page, pageSize, total };
  }

  async get(user: AuthenticatedUser, registrationNumber: string) {
    await this.requireViewPermission(user);
    const record = await this.prisma.registryRecord.findUnique({
      where: { registrationNumber: registrationNumber.trim().toUpperCase() },
    });
    if (!record) throw new NotFoundException('Student is not in the registry.');
    return record;
  }

  async importRows(
    user: AuthenticatedUser,
    body: { mode: unknown; sourceFilename: unknown; students: unknown },
  ) {
    const mode =
      body.mode === 'replace'
        ? 'REPLACE'
        : body.mode === 'merge'
          ? 'MERGE'
          : null;
    const sourceFilename = this.requiredString(
      body.sourceFilename,
      'sourceFilename',
    );
    if (
      !mode ||
      !Array.isArray(body.students) ||
      body.students.length === 0 ||
      body.students.length > 20_000
    ) {
      throw new BadRequestException(
        'Provide a merge/replace mode and between 1 and 20,000 student rows.',
      );
    }
    if (user.role === UserRole.ELECTION_OFFICER) {
      const allowed = await this.prisma.rolePermission.findFirst({
        where: {
          role: UserRole.ELECTION_OFFICER,
          permission: 'IMPORT_REGISTRY',
          enabled: true,
        },
      });
      const configured = await this.prisma.rolePermission.findFirst({
        where: {
          role: UserRole.ELECTION_OFFICER,
          permission: 'IMPORT_REGISTRY',
        },
      });
      if (configured && !allowed)
        throw new ForbiddenException(
          'Registry import is not enabled for election officers.',
        );
    }

    const records = (body.students as ImportRow[]).map((row, index) =>
      this.mapRow(row, index),
    );
    const regNumbers = new Set<string>();
    for (const row of records) {
      if (regNumbers.has(row.registrationNumber))
        throw new BadRequestException(
          `Duplicate registration number ${row.registrationNumber} in import.`,
        );
      regNumbers.add(row.registrationNumber);
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        const beforeCount = await tx.registryRecord.count();
        if (mode === 'REPLACE') {
          await tx.registryRecord.deleteMany({
            where: {
              registrationNumber: {
                notIn: records.map((record) => record.registrationNumber),
              },
              studentProfile: null,
              nominations: { none: {} },
              voterParticipations: { none: {} },
            },
          });
        }
        for (let offset = 0; offset < records.length; offset += 250) {
          const batch = records.slice(offset, offset + 250);
          const values = batch.map(
            (record) =>
              Prisma.sql`(
            ${record.registrationNumber},
            ${record.firstName},
            ${record.lastName},
            ${record.gender}::"Gender",
            ${record.dateOfBirth},
            ${record.email},
            ${record.collegeCode},
            ${record.college},
            ${record.school},
            ${record.department},
            ${record.programme},
            ${record.campus},
            ${record.level}::"StudyLevel",
            ${record.yearOfStudy},
            ${record.enrolment}::"EnrolmentStatus",
            ${record.registeredAcademicYear},
            ${record.studyStart},
            ${record.studyEnd},
            ${record.cumulativeGpa ?? null},
            ${record.openDisciplinaryCase ?? null},
            CURRENT_TIMESTAMP
          )`,
          );
          await tx.$executeRaw(Prisma.sql`
          INSERT INTO "registry_records" (
            "registrationNumber", "firstName", "lastName", "gender", "dateOfBirth",
            "email", "collegeCode", "college", "school", "department", "programme",
            "campus", "level", "yearOfStudy", "enrolment", "registeredAcademicYear",
            "studyStart", "studyEnd", "cumulativeGpa", "openDisciplinaryCase", "updatedAt"
          )
          VALUES ${Prisma.join(values)}
          ON CONFLICT ("registrationNumber") DO UPDATE SET
            "firstName" = EXCLUDED."firstName",
            "lastName" = EXCLUDED."lastName",
            "gender" = EXCLUDED."gender",
            "dateOfBirth" = EXCLUDED."dateOfBirth",
            "email" = EXCLUDED."email",
            "collegeCode" = EXCLUDED."collegeCode",
            "college" = EXCLUDED."college",
            "school" = EXCLUDED."school",
            "department" = EXCLUDED."department",
            "programme" = EXCLUDED."programme",
            "campus" = EXCLUDED."campus",
            "level" = EXCLUDED."level",
            "yearOfStudy" = EXCLUDED."yearOfStudy",
            "enrolment" = EXCLUDED."enrolment",
            "registeredAcademicYear" = EXCLUDED."registeredAcademicYear",
            "studyStart" = EXCLUDED."studyStart",
            "studyEnd" = EXCLUDED."studyEnd",
            "cumulativeGpa" = COALESCE(EXCLUDED."cumulativeGpa", "registry_records"."cumulativeGpa"),
            "openDisciplinaryCase" = COALESCE(EXCLUDED."openDisciplinaryCase", "registry_records"."openDisciplinaryCase"),
            "updatedAt" = CURRENT_TIMESTAMP
        `);
        }
        const afterCount = await tx.registryRecord.count();
        const retainedCount = Math.max(0, afterCount - records.length);
        await tx.registryImport.create({
          data: {
            sourceFilename,
            mode,
            importedRows: records.length,
            rejectedRows: 0,
            actorId: user.id,
          },
        });
        await tx.activityLog.create({
          data: {
            actorId: user.id,
            actorLabel: user.registrationNumber ?? user.email ?? user.name,
            actorRole: this.activityRole(user.role),
            type: ActivityType.REGISTRY,
            severity: ActivitySeverity.WARNING,
            detail: `Imported ${records.length} registry records (${mode.toLowerCase()}).`,
            beforeValue: `${beforeCount} registry records`,
            afterValue: `${afterCount} registry records; ${retainedCount} existing records retained`,
          },
        });
        return {
          imported: records.length,
          total: afterCount,
          retained: retainedCount,
        };
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
    return { success: true, ...result };
  }

  private mapRow(row: ImportRow, index: number) {
    const name = this.optionalString(row.name);
    const nameParts = name?.trim().split(/\s+/) ?? [];
    const firstName = this.optionalString(row.firstName) ?? nameParts.shift();
    const lastName = this.optionalString(row.lastName) ?? nameParts.join(' ');
    const registrationNumber = this.requiredString(
      row.registrationNumber ?? row.regNumber,
      `students[${index}].registrationNumber`,
    ).toUpperCase();
    if (!firstName || !lastName)
      throw new BadRequestException(
        `Student row ${index + 1} must include first and last names.`,
      );
    const college = this.requiredString(
      row.college,
      `students[${index}].college`,
    );
    const school = this.requiredString(
      row.school ?? row.faculty,
      `students[${index}].school`,
    );
    const department = this.requiredString(
      row.department,
      `students[${index}].department`,
    );
    const campus = this.requiredString(row.campus, `students[${index}].campus`);
    const enrolment = this.enumValue(
      row.enrolment,
      Object.values(EnrolmentStatus),
      EnrolmentStatus.ACTIVE,
    );
    const genderValue = this.optionalString(row.gender)?.toUpperCase();
    const levelValue = this.optionalString(row.level)?.toUpperCase();
    const currentYear = this.optionalString(row.currentYear);
    const currentYearParts = currentYear?.match(
      /^(\d{4})\s*\/\s*(\d{2}|\d{4})$/,
    );
    const normalizedCurrentAcademicYear = currentYearParts
      ? `${currentYearParts[1]}/${currentYearParts[2].length === 2 ? `${currentYearParts[1].slice(0, 2)}${currentYearParts[2]}` : currentYearParts[2]}`
      : null;
    const studyYearInput =
      row.yearOfStudy ??
      (currentYear && /^\s*(?:year\s*)?\d{1,2}\s*$/i.test(currentYear)
        ? currentYear.match(/\d+/)?.[0]
        : null);
    const gpaInput = row.cumulativeGpa ?? row.gpa;
    const gpaNumber =
      gpaInput == null || gpaInput === '' ? undefined : Number(gpaInput);
    if (
      gpaNumber !== undefined &&
      (!Number.isFinite(gpaNumber) || gpaNumber < 0 || gpaNumber > 4)
    )
      throw new BadRequestException(
        `Student row ${index + 1} cumulative GPA must be from 0 to 4.`,
      );
    const disciplinaryInput = row.openDisciplinaryCase ?? row.disciplinaryCase;
    const disciplinaryText =
      typeof disciplinaryInput === 'string'
        ? disciplinaryInput.trim().toLowerCase()
        : disciplinaryInput;
    const openDisciplinaryCase =
      disciplinaryText == null || disciplinaryText === ''
        ? undefined
        : disciplinaryText === true ||
            ['yes', 'true', '1', 'open'].includes(String(disciplinaryText))
          ? true
          : disciplinaryText === false ||
              ['no', 'false', '0', 'none'].includes(String(disciplinaryText))
            ? false
            : undefined;
    if (
      disciplinaryText != null &&
      disciplinaryText !== '' &&
      openDisciplinaryCase === undefined
    )
      throw new BadRequestException(
        `Student row ${index + 1} disciplinary case must be Yes or No.`,
      );
    return {
      registrationNumber,
      firstName,
      lastName,
      gender:
        genderValue === 'F' || genderValue === 'FEMALE'
          ? Gender.FEMALE
          : genderValue === 'M' || genderValue === 'MALE'
            ? Gender.MALE
            : null,
      dateOfBirth: this.date(row.dateOfBirth),
      email: this.optionalString(row.email)?.toLowerCase() ?? null,
      collegeCode: this.optionalString(row.collegeCode) ?? null,
      college,
      school,
      department,
      programme: this.optionalString(row.programme ?? row.program) ?? null,
      campus,
      level:
        levelValue === 'UNDERGRADUATE'
          ? StudyLevel.UNDERGRADUATE
          : levelValue === 'POSTGRADUATE'
            ? StudyLevel.POSTGRADUATE
            : null,
      yearOfStudy:
        studyYearInput == null || studyYearInput === ''
          ? null
          : this.number(String(studyYearInput), 0, 1, 20),
      enrolment,
      registeredAcademicYear:
        this.optionalString(row.registeredAcademicYear ?? row.academicYear) ??
        normalizedCurrentAcademicYear,
      studyStart: this.date(row.studyStart),
      studyEnd: this.date(row.studyEnd),
      cumulativeGpa:
        gpaNumber === undefined ? undefined : new Prisma.Decimal(gpaNumber),
      openDisciplinaryCase,
    };
  }

  private activityRole(role: UserRole): ActivityActorRole {
    if (role === UserRole.STUDENT) return ActivityActorRole.STUDENT;
    if (role === UserRole.ELECTION_OFFICER)
      return ActivityActorRole.ELECTION_OFFICER;
    return ActivityActorRole.ADMINISTRATOR;
  }

  private async requireViewPermission(user: AuthenticatedUser) {
    if (user.role === UserRole.SYSTEM_ADMINISTRATOR) return;
    const configured = await this.prisma.rolePermission.findFirst({
      where: { role: UserRole.ELECTION_OFFICER, permission: 'VIEW_VOTER_ROLL' },
    });
    if (configured && !configured.enabled)
      throw new ForbiddenException(
        'Viewing the registry is not enabled for election officers.',
      );
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${field} is required.`);
    return value.trim();
  }

  private optionalString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private date(value: unknown) {
    if (value == null || value === '') return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException(`Invalid date value: ${String(value)}.`);
    return date;
  }

  private number(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ) {
    if (value == null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max)
      throw new BadRequestException(
        `Expected an integer between ${min} and ${max}.`,
      );
    return parsed;
  }

  private enumValue<T extends string>(
    value: unknown,
    values: T[],
    fallback: T,
  ) {
    const normalized = typeof value === 'string' ? value.toUpperCase() : '';
    return (values as string[]).includes(normalized)
      ? (normalized as T)
      : fallback;
  }
}
