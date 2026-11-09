import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ElectionScopeLevel, UserRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class VoterRollService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    user: AuthenticatedUser,
    electionId: string,
    query: {
      q?: string;
      school?: string;
      voted?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    if (user.role === UserRole.ELECTION_OFFICER) {
      const permission = await this.prisma.rolePermission.findFirst({
        where: {
          role: UserRole.ELECTION_OFFICER,
          permission: 'VIEW_VOTER_ROLL',
        },
      });
      if (permission && !permission.enabled)
        throw new ForbiddenException(
          'Voter roll access is not enabled for election officers.',
        );
    }
    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
    });
    if (!election) throw new NotFoundException('Election was not found.');
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
    });
    const scope: Prisma.RegistryRecordWhereInput =
      election.scopeLevel === ElectionScopeLevel.UNIVERSITY
        ? {}
        : election.scopeLevel === ElectionScopeLevel.COLLEGE
          ? {
              OR: [
                { collegeCode: election.scopeValue ?? '' },
                { college: election.scopeValue ?? '' },
              ],
            }
          : election.scopeLevel === ElectionScopeLevel.SCHOOL
            ? { school: election.scopeValue ?? '' }
            : election.scopeLevel === ElectionScopeLevel.DEPARTMENT
              ? { department: election.scopeValue ?? '' }
              : { campus: election.scopeValue ?? '' };
    const eligibility: Prisma.RegistryRecordWhereInput = {
      enrolment: 'ACTIVE',
      OR: [
        { registeredAcademicYear: settings?.academicYearLabel ?? '2026/2027' },
        { registeredAcademicYear: null },
      ],
      AND: [
        { OR: [{ studyEnd: null }, { studyEnd: { gte: election.closesOn } }] },
        scope,
      ],
    };
    const eligibleCount = await this.prisma.registryRecord.count({
      where: eligibility,
    });
    const votedCount = await this.prisma.voterParticipation.count({
      where: { electionId },
    });
    const votedFilter =
      query.voted === 'yes'
        ? { some: { electionId } }
        : query.voted === 'no'
          ? { none: { electionId } }
          : undefined;
    const search = query.q?.trim();
    const where: Prisma.RegistryRecordWhereInput = {
      AND: [
        eligibility,
        ...(query.school ? [{ school: query.school }] : []),
        ...(search
          ? [
              {
                OR: [
                  {
                    registrationNumber: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    firstName: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    lastName: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                ],
              },
            ]
          : []),
      ],
      ...(votedFilter ? { voterParticipations: votedFilter } : {}),
    };
    const page = this.integer(query.page, 1, 1, 100_000);
    const pageSize = this.integer(query.pageSize, 25, 1, 200);
    const [items, total, schools] = await this.prisma.$transaction([
      this.prisma.registryRecord.findMany({
        where,
        select: {
          registrationNumber: true,
          firstName: true,
          lastName: true,
          school: true,
          campus: true,
          voterParticipations: {
            where: { electionId },
            select: { id: true },
            take: 1,
          },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.registryRecord.count({ where }),
      this.prisma.registryRecord.findMany({
        where: eligibility,
        distinct: ['school'],
        select: { school: true },
        orderBy: { school: 'asc' },
      }),
    ]);
    return {
      election: {
        id: election.id,
        title: election.title,
        eligibleCount,
        votedCount,
      },
      filters: { schools: schools.map((row) => row.school) },
      items: items.map((row) => ({
        registrationNumber: row.registrationNumber,
        name: `${row.firstName} ${row.lastName}`.trim(),
        school: row.school,
        campus: row.campus,
        voted: row.voterParticipations.length > 0,
      })),
      page,
      pageSize,
      total,
    };
  }

  private integer(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ) {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed)
      ? Math.min(max, Math.max(min, parsed))
      : fallback;
  }
}
