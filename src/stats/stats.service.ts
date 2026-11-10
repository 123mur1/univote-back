import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  ElectionStatus,
  NominationStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  electorateWhere,
  inScope,
  registryStanding,
} from '../common/eligibility';
import { ElectionsService } from '../elections/elections.service';

const DAY = 86_400_000;

type Filters = { college?: string; campus?: string; days?: string };

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly elections: ElectionsService,
  ) {}

  private academicYear() {
    return this.elections.academicYearLabel();
  }

  // Everything the system administrator's overview needs, in one round trip.
  async admin(filters: Filters) {
    await this.elections.syncStatuses();
    const academicYear = await this.academicYear();
    const days = Math.min(90, Math.max(7, Number(filters.days) || 30));
    const since = new Date(Date.now() - days * DAY);
    const registryWhere: Prisma.RegistryRecordWhereInput = {
      ...(filters.college ? { college: filters.college } : {}),
      ...(filters.campus ? { campus: filters.campus } : {}),
    };
    const today = new Date();
    const currentWhere: Prisma.RegistryRecordWhereInput = {
      ...registryWhere,
      enrolment: 'ACTIVE',
      OR: [
        { registeredAcademicYear: academicYear },
        { registeredAcademicYear: null },
      ],
      AND: [{ OR: [{ studyEnd: null }, { studyEnd: { gte: today } }] }],
    };

    const [
      registryTotal,
      registryCurrent,
      withAccount,
      byEnrolment,
      byCollege,
      byCampus,
      byLevel,
      byGender,
      byYear,
      usersByRole,
      suspended,
      settings,
      elections,
      nominationsByStatus,
      signups,
      ballots,
      activity,
      recentAlerts,
      lastImport,
    ] = await Promise.all([
      this.prisma.registryRecord.count({ where: registryWhere }),
      this.prisma.registryRecord.count({ where: currentWhere }),
      this.prisma.registryRecord.count({
        where: { ...registryWhere, studentProfile: { isNot: null } },
      }),
      this.group('enrolment', registryWhere),
      this.group('college', registryWhere),
      this.group('campus', registryWhere),
      this.group('level', registryWhere),
      this.group('gender', registryWhere),
      this.group('yearOfStudy', registryWhere),
      this.prisma.user.groupBy({
        by: ['role'],
        _count: { _all: true },
        orderBy: { role: 'asc' },
      }),
      this.prisma.user.count({ where: { active: false } }),
      this.prisma.systemSettings.findUnique({ where: { id: 'default' } }),
      this.prisma.election.findMany({
        orderBy: { opensAt: 'desc' },
        include: {
          contests: { include: { _count: { select: { candidates: true } } } },
          _count: { select: { voterParticipations: true, nominations: true } },
        },
      }),
      this.prisma.nomination.groupBy({
        by: ['status'],
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.user.findMany({
        where: { role: UserRole.STUDENT, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      this.prisma.voterParticipation.findMany({
        where: { castAt: { gte: since } },
        select: { castAt: true },
      }),
      this.prisma.activityLog.findMany({
        where: { occurredAt: { gte: since } },
        select: { occurredAt: true, type: true, severity: true },
      }),
      this.prisma.activityLog.findMany({
        where: { severity: { in: ['WARNING', 'CRITICAL'] } },
        orderBy: { occurredAt: 'desc' },
        take: 8,
      }),
      this.prisma.registryImport.findFirst({ orderBy: { createdAt: 'desc' } }),
    ]);
    const locked = await this.prisma.user.count({
      where: { failedSignIns: { gte: settings?.maxFailedLogins ?? 5 } },
    });

    const electionRows = await Promise.all(
      elections.map(async (election) => {
        const eligible = await this.prisma.registryRecord.count({
          where: {
            ...electorateWhere(election, academicYear),
            ...registryWhere,
          },
        });
        const voted = Object.keys(registryWhere).length
          ? await this.prisma.voterParticipation.count({
              where: { electionId: election.id, student: registryWhere },
            })
          : election._count.voterParticipations;
        return {
          id: election.id,
          title: election.title,
          status: election.status,
          scopeLevel: election.scopeLevel,
          scopeValue: election.scopeValue,
          opensAt: election.opensAt,
          closesAt: election.closesAt,
          positions: election.contests.length,
          candidates: election.contests.reduce(
            (sum, contest) => sum + contest._count.candidates,
            0,
          ),
          nominations: election._count.nominations,
          eligible,
          voted,
        };
      }),
    );

    return {
      generatedAt: new Date().toISOString(),
      academicYear,
      filters: {
        college: filters.college ?? null,
        campus: filters.campus ?? null,
        days,
      },
      registry: {
        total: registryTotal,
        current: registryCurrent,
        withAccount,
        lastImport,
        byEnrolment,
        byCollege,
        byCampus,
        byLevel,
        byGender,
        byYear,
      },
      users: {
        byRole: usersByRole.map((row) => ({
          role: row.role,
          count: row._count._all,
        })),
        suspended,
        locked,
      },
      elections: electionRows,
      nominations: nominationsByStatus.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      timeline: this.timeline(days, {
        signups: signups.map((row) => row.createdAt),
        ballots: ballots.map((row) => row.castAt),
        logins: activity
          .filter((row) => row.type === 'LOGIN')
          .map((row) => row.occurredAt),
        failedLogins: activity
          .filter((row) => row.type === 'LOGIN_FAILED')
          .map((row) => row.occurredAt),
      }),
      activityByType: this.countBy(activity.map((row) => row.type)),
      recentAlerts,
    };
  }

  async officer(user: AuthenticatedUser) {
    if (
      user.role !== UserRole.ELECTION_OFFICER &&
      user.role !== UserRole.SYSTEM_ADMINISTRATOR
    )
      throw new ForbiddenException();
    await this.elections.syncStatuses();
    const academicYear = await this.academicYear();
    const [elections, nominations, registryTotal, recent] = await Promise.all([
      this.prisma.election.findMany({
        orderBy: { opensAt: 'desc' },
        include: {
          contests: { include: { _count: { select: { candidates: true } } } },
          _count: { select: { voterParticipations: true } },
        },
      }),
      this.prisma.nomination.groupBy({
        by: ['status'],
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.registryRecord.count(),
      this.prisma.nomination.findMany({
        where: { status: NominationStatus.PENDING },
        orderBy: { submittedAt: 'desc' },
        take: 6,
        include: {
          contest: { select: { title: true } },
          election: { select: { title: true } },
        },
      }),
    ]);
    const rows = await Promise.all(
      elections.map(async (election) => ({
        id: election.id,
        title: election.title,
        status: election.status,
        scopeLevel: election.scopeLevel,
        scopeValue: election.scopeValue,
        opensAt: election.opensAt,
        closesAt: election.closesAt,
        nominationsClose: election.nominationsClose,
        positions: election.contests.length,
        candidates: election.contests.reduce(
          (sum, contest) => sum + contest._count.candidates,
          0,
        ),
        eligible: await this.prisma.registryRecord.count({
          where: electorateWhere(election, academicYear),
        }),
        voted: election._count.voterParticipations,
      })),
    );
    return {
      academicYear,
      registryTotal,
      elections: rows,
      nominations: nominations.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      pending: recent.map((row) => ({
        id: row.id,
        name: row.name,
        registrationNumber: row.studentRegistrationNo,
        contest: row.contest.title,
        election: row.election.title,
        submittedAt: row.submittedAt,
      })),
    };
  }

  // A student's whole dashboard: their registry record, standing and each election's status.
  async student(user: AuthenticatedUser) {
    if (user.role !== UserRole.STUDENT || !user.registrationNumber)
      throw new ForbiddenException('A student account is required.');
    await this.elections.syncStatuses();
    const academicYear = await this.academicYear();
    const [record, elections, participations, nominations] = await Promise.all([
      this.prisma.registryRecord.findUnique({
        where: { registrationNumber: user.registrationNumber },
      }),
      this.prisma.election.findMany({
        orderBy: { opensAt: 'asc' },
        include: {
          contests: {
            orderBy: { sortOrder: 'asc' },
            include: {
              candidates: {
                orderBy: { name: 'asc' },
                select: {
                  id: true,
                  name: true,
                  photoUrl: true,
                  programme: true,
                  year: true,
                  manifesto: true,
                  publishedVotes: true,
                },
              },
            },
          },
          _count: { select: { voterParticipations: true } },
        },
      }),
      this.prisma.voterParticipation.findMany({
        where: { studentRegistrationNo: user.registrationNumber },
        select: { electionId: true, castAt: true },
      }),
      this.prisma.nomination.findMany({
        where: { studentRegistrationNo: user.registrationNumber },
        orderBy: { submittedAt: 'desc' },
        include: {
          contest: { select: { title: true } },
          election: { select: { title: true, status: true } },
          documents: { select: { id: true } },
        },
      }),
    ]);
    const now = new Date();
    const standing = record
      ? registryStanding(record, academicYear, now)
      : {
          ok: false,
          reasons: ['You are not on the current student registry.'],
        };
    const voted = new Map(
      participations.map((row) => [row.electionId, row.castAt]),
    );
    const rows = await Promise.all(
      elections.map(async (election) => {
        const scoped = record ? inScope(record, election) : false;
        const forElection = record
          ? registryStanding(record, academicYear, election.closesOn)
          : { ok: false, reasons: [] };
        const published = election.status === ElectionStatus.PUBLISHED;
        return {
          id: election.id,
          title: election.title,
          description: election.description,
          status: election.status,
          scopeLevel: election.scopeLevel,
          scopeValue: election.scopeValue,
          opensAt: election.opensAt,
          closesAt: election.closesAt,
          nominationsClose: election.nominationsClose,
          inScope: scoped,
          canVote: scoped && forElection.ok,
          voted: voted.has(election.id),
          votedAt: voted.get(election.id) ?? null,
          ballotsCast: election._count.voterParticipations,
          eligibleCount: await this.prisma.registryRecord.count({
            where: electorateWhere(election, academicYear),
          }),
          resultHash: published ? election.resultHash : null,
          contests: election.contests.map((contest) => ({
            id: contest.id,
            title: contest.title,
            seats: contest.seats,
            candidates: contest.candidates.map((candidate) => ({
              ...candidate,
              publishedVotes: published ? candidate.publishedVotes : null,
            })),
          })),
        };
      }),
    );
    return {
      academicYear,
      record,
      standing,
      candidacy: record
        ? {
            gpa: record.cumulativeGpa ? Number(record.cumulativeGpa) : null,
            gpaOk:
              record.cumulativeGpa !== null &&
              Number(record.cumulativeGpa) >= 2.5,
            disciplinaryOk: record.openDisciplinaryCase === false,
          }
        : null,
      elections: rows,
      nominations: nominations.map((row) => ({
        id: row.id,
        contest: row.contest.title,
        election: row.election.title,
        electionStatus: row.election.status,
        status: row.status,
        decisionNote: row.decisionNote,
        submittedAt: row.submittedAt,
        documents: row.documents.length,
      })),
    };
  }

  private async group(
    field:
      'enrolment' | 'college' | 'campus' | 'level' | 'gender' | 'yearOfStudy',
    where: Prisma.RegistryRecordWhereInput,
  ) {
    const rows = await this.prisma.registryRecord.groupBy({
      by: [field],
      where,
      _count: { _all: true },
    });
    return rows
      .map((row) => ({
        label:
          (row as Record<string, unknown>)[field] == null
            ? 'Not recorded'
            : String((row as Record<string, unknown>)[field]),
        value: row._count._all,
      }))
      .sort((a, b) => b.value - a.value);
  }

  private countBy(values: string[]) {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }

  private timeline(days: number, series: Record<string, Date[]>) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const first = start.getTime() - (days - 1) * DAY;
    const rows: Record<string, number | string>[] = Array.from(
      { length: days },
      (_, index) => ({
        date: new Date(first + index * DAY).toISOString().slice(0, 10),
        ...Object.fromEntries(Object.keys(series).map((key) => [key, 0])),
      }),
    );
    for (const [key, dates] of Object.entries(series)) {
      for (const date of dates) {
        const index = Math.floor((date.getTime() - first) / DAY);
        if (index >= 0 && index < days)
          rows[index][key] = (rows[index][key] as number) + 1;
      }
    }
    return rows;
  }
}
