import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivitySeverity,
  ActivityType,
  ElectionScopeLevel,
  ElectionStatus,
  ElectionAuditRole,
  UserRole,
  Prisma,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

type CreateElectionInput = {
  title?: unknown;
  description?: unknown;
  scopeLevel?: unknown;
  scopeValue?: unknown;
  opensAt?: unknown;
  closesAt?: unknown;
  closesOn?: unknown;
  nominationsClose?: unknown;
  contests?: unknown;
  publicKey?: unknown;
};

@Injectable()
export class ElectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // Moves elections through their schedule: upcoming -> open at opensAt, open -> closed at
  // closesAt. Each transition is a conditional update, so concurrent requests only apply (and
  // announce) it once.
  // The database is remote, so every round trip is costly. Status transitions are checked at
  // most every 15 seconds (always when a ballot is cast) and the academic year is cached briefly.
  private lastSync = 0;
  private yearCache: { label: string; at: number } | null = null;

  async academicYearLabel() {
    if (this.yearCache && Date.now() - this.yearCache.at < 30_000)
      return this.yearCache.label;
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
      select: { academicYearLabel: true },
    });
    this.yearCache = {
      label: settings?.academicYearLabel ?? '2026/2027',
      at: Date.now(),
    };
    return this.yearCache.label;
  }

  async syncStatuses(force = false) {
    if (!force && Date.now() - this.lastSync < 15_000) return;
    this.lastSync = Date.now();
    const now = new Date();
    const due = await this.prisma.election.findMany({
      where: {
        OR: [
          { status: ElectionStatus.UPCOMING, opensAt: { lte: now } },
          { status: ElectionStatus.OPEN, closesAt: { lte: now } },
        ],
      },
      select: { id: true, title: true, status: true, closesAt: true },
    });
    for (const election of due) {
      const next =
        election.closesAt <= now ? ElectionStatus.CLOSED : ElectionStatus.OPEN;
      const changed = await this.prisma.election.updateMany({
        where: { id: election.id, status: election.status },
        data: { status: next },
      });
      if (changed.count !== 1) continue;
      await this.audit.electionEvent({
        electionId: election.id,
        actorLabel: 'scheduler',
        role: ElectionAuditRole.SYSTEM,
        action: `Election status changed automatically from ${election.status} to ${next}.`,
      });
      await this.announceStatus(election.id, election.title, next);
    }
  }

  private async announceStatus(
    id: string,
    title: string,
    status: ElectionStatus,
  ) {
    if (status === ElectionStatus.OPEN) {
      await this.notifications.toRoles([UserRole.STUDENT], {
        kind: 'election',
        title: `Voting is open: ${title}`,
        body: 'Check your eligibility, meet the candidates and cast your encrypted ballot before voting closes.',
        link: `/student/elections/${id}`,
      });
      await this.notifications.toRoles(
        [UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR],
        {
          kind: 'election',
          title: `Voting opened: ${title}`,
          body: 'Follow live turnout from the monitoring dashboard.',
          link: '/officer',
        },
      );
    }
    if (status === ElectionStatus.CLOSED) {
      await this.notifications.toRoles([UserRole.STUDENT], {
        kind: 'election',
        title: `Voting has closed: ${title}`,
        body: 'Ballots are being counted. You will be notified when official results are published.',
        link: '/student/results',
      });
      await this.notifications.toRoles(
        [UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR],
        {
          kind: 'election',
          title: `Ready to count: ${title}`,
          body: 'Voting has closed. Decrypt the ballots with the trustee key and publish the official results.',
          link: '/officer/elections',
        },
      );
    }
  }

  async list() {
    await this.syncStatuses();
    return this.prisma.election
      .findMany({
        include: {
          contests: {
            orderBy: { sortOrder: 'asc' },
            include: { candidates: { orderBy: { name: 'asc' } } },
          },
          _count: {
            select: { encryptedBallots: true, voterParticipations: true },
          },
        },
        orderBy: { opensAt: 'desc' },
      })
      .then(async (rows) => {
        const academicYear = await this.academicYearLabel();
        return Promise.all(
          rows.map(async (election) => ({
            ...this.hideUnpublishedTallies(election),
            eligibleCount: await this.prisma.registryRecord.count({
              where: this.eligibleWhere(election, academicYear),
            }),
          })),
        );
      });
  }

  async get(id: string) {
    await this.syncStatuses();
    const election = await this.prisma.election.findUnique({
      where: { id },
      include: {
        contests: {
          orderBy: { sortOrder: 'asc' },
          include: { candidates: { orderBy: { name: 'asc' } } },
        },
        _count: {
          select: { encryptedBallots: true, voterParticipations: true },
        },
      },
    });
    if (!election) throw new NotFoundException('Election was not found.');
    const academicYear = await this.academicYearLabel();
    return {
      ...this.hideUnpublishedTallies(election),
      eligibleCount: await this.prisma.registryRecord.count({
        where: this.eligibleWhere(election, academicYear),
      }),
    };
  }

  private eligibleWhere(
    election: {
      scopeLevel: ElectionScopeLevel;
      scopeValue: string | null;
      closesOn: Date;
    },
    academicYearLabel: string,
  ): Prisma.RegistryRecordWhereInput {
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
    return {
      enrolment: 'ACTIVE',
      OR: [
        { registeredAcademicYear: academicYearLabel },
        { registeredAcademicYear: null },
      ],
      AND: [
        { OR: [{ studyEnd: null }, { studyEnd: { gte: election.closesOn } }] },
        scope,
      ],
    };
  }

  async results(id: string) {
    const election = await this.get(id);
    if (election.status !== ElectionStatus.PUBLISHED)
      throw new NotFoundException('Published results were not found.');
    return election;
  }

  async encryptedBallots(user: AuthenticatedUser, id: string) {
    const authorizedRoles: UserRole[] = [
      UserRole.ELECTION_OFFICER,
      UserRole.DISPUTE_RESOLUTION_COMMITTEE,
      UserRole.SYSTEM_ADMINISTRATOR,
    ];
    if (!authorizedRoles.includes(user.role))
      throw new ForbiddenException(
        'An authorized election official is required.',
      );
    const election = await this.prisma.election.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        contests: {
          select: { id: true, candidates: { select: { id: true } } },
        },
        encryptedBallots: {
          select: { encryptedPayload: true, receiptHash: true },
          orderBy: { castAt: 'asc' },
        },
      },
    });
    if (!election) throw new NotFoundException('Election was not found.');
    if (election.status !== ElectionStatus.CLOSED)
      throw new BadRequestException(
        'Encrypted ballots are available to trustees only after voting closes.',
      );
    return election;
  }

  async publishedBallots(id: string) {
    const election = await this.prisma.election.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        encryptedBallots: {
          select: { encryptedPayload: true, receiptHash: true, castAt: true },
          orderBy: { castAt: 'asc' },
        },
      },
    });
    if (!election) throw new NotFoundException('Election was not found.');
    if (election.status !== ElectionStatus.PUBLISHED)
      throw new NotFoundException('Published ballots were not found.');
    return election;
  }

  async turnout(id: string) {
    const election = await this.prisma.election.findUnique({ where: { id } });
    if (!election) throw new NotFoundException('Election was not found.');
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
    });
    const [eligibleCount, votes] = await Promise.all([
      this.prisma.registryRecord.count({
        where: this.eligibleWhere(
          election,
          settings?.academicYearLabel ?? '2026/2027',
        ),
      }),
      this.prisma.voterParticipation.findMany({
        where: { electionId: id },
        select: {
          castAt: true,
          student: { select: { collegeCode: true, college: true } },
        },
        orderBy: { castAt: 'asc' },
      }),
    ]);
    const byHour = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      ballots: 0,
    }));
    const colleges = new Map<string, { eligible: number; voted: number }>();
    for (const vote of votes) {
      byHour[vote.castAt.getUTCHours()].ballots++;
      const key = vote.student.collegeCode ?? vote.student.college;
      const summary = colleges.get(key) ?? { eligible: 0, voted: 0 };
      summary.voted++;
      colleges.set(key, summary);
    }
    const electorate = await this.prisma.registryRecord.findMany({
      where: this.eligibleWhere(
        election,
        settings?.academicYearLabel ?? '2026/2027',
      ),
      select: { collegeCode: true, college: true },
    });
    for (const student of electorate) {
      const key = student.collegeCode ?? student.college;
      const summary = colleges.get(key) ?? { eligible: 0, voted: 0 };
      summary.eligible++;
      colleges.set(key, summary);
    }
    return {
      electionId: id,
      eligibleCount,
      votedCount: votes.length,
      byHour,
      byCollege: [...colleges].map(([college, counts]) => ({
        college,
        ...counts,
      })),
    };
  }

  async create(user: AuthenticatedUser, input: CreateElectionInput) {
    await this.requireElectionPermission(user);
    const title = this.required(input.title, 'title');
    const scopeLevel = this.enumValue(
      input.scopeLevel,
      Object.values(ElectionScopeLevel),
      'scopeLevel',
    );
    const scopeValue =
      typeof input.scopeValue === 'string' && input.scopeValue.trim()
        ? input.scopeValue.trim()
        : null;
    if (scopeLevel !== ElectionScopeLevel.UNIVERSITY && !scopeValue)
      throw new BadRequestException(
        'scopeValue is required for a scoped election.',
      );
    const opensAt = this.date(input.opensAt, 'opensAt');
    const closesAt = this.date(input.closesAt, 'closesAt');
    const closesOn = this.date(
      input.closesOn ?? closesAt.toISOString(),
      'closesOn',
    );
    const nominationsClose =
      input.nominationsClose == null
        ? null
        : this.date(input.nominationsClose, 'nominationsClose');
    if (closesAt <= opensAt)
      throw new BadRequestException('closesAt must be after opensAt.');
    const contests = this.contests(input.contests);
    const publicKey = this.publicKey(input.publicKey);

    const election = await this.prisma.election.create({
      data: {
        title,
        description:
          typeof input.description === 'string'
            ? input.description.trim()
            : null,
        scopeLevel,
        scopeValue,
        opensAt,
        closesAt,
        closesOn,
        nominationsClose,
        publicKey,
        status:
          opensAt > new Date() ? ElectionStatus.UPCOMING : ElectionStatus.OPEN,
        createdById: user.id,
        contests: {
          create: contests.map((contest, sortOrder) => ({
            ...contest,
            sortOrder,
          })),
        },
      },
      include: { contests: true },
    });
    await this.audit.activity(user, {
      type: ActivityType.ELECTION,
      severity: ActivitySeverity.INFO,
      detail: `Created election draft ${title}.`,
      beforeValue: 'No election',
      afterValue: JSON.stringify({
        title,
        scopeLevel,
        scopeValue,
        opensAt,
        closesAt,
        contests,
      }),
    });
    await this.audit.electionEvent({
      user,
      electionId: election.id,
      action: `Created election draft: ${title}.`,
    });
    const audience =
      scopeLevel === ElectionScopeLevel.UNIVERSITY
        ? 'all students'
        : `students in ${scopeValue}`;
    const nominationNote = nominationsClose
      ? `Nominations close ${nominationsClose.toISOString().slice(0, 10)}. `
      : '';
    await this.notifications.toRoles([UserRole.STUDENT], {
      kind: 'election',
      title: `New election: ${title}`,
      body: `Open to ${audience}. ${nominationNote}Voting opens ${opensAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      link: `/student/elections/${election.id}`,
    });
    const positions = `${contests.length} position${contests.length === 1 ? '' : 's'}`;
    await this.notifications.toRoles(
      [UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR],
      {
        kind: 'election',
        title: `Election created: ${title}`,
        body: `${user.name} created this election with ${positions}.`,
        link: `/officer/elections/${election.id}`,
      },
    );
    return election;
  }

  async updateStatus(
    user: AuthenticatedUser,
    id: string,
    statusValue: unknown,
  ) {
    await this.requireElectionPermission(user);
    const status = this.enumValue(
      statusValue,
      Object.values(ElectionStatus),
      'status',
    );
    const current = await this.get(id);
    if (
      current.status === ElectionStatus.PUBLISHED &&
      status !== ElectionStatus.PUBLISHED
    )
      throw new BadRequestException(
        'A published election cannot be reopened or changed.',
      );
    if (status === ElectionStatus.PUBLISHED)
      throw new BadRequestException(
        'Use the official publish results action to publish an election.',
      );
    if (
      status === ElectionStatus.OPEN &&
      current.status === ElectionStatus.UPCOMING &&
      new Date() < current.opensAt
    )
      throw new BadRequestException(
        'An election cannot be opened before its scheduled start.',
      );
    if (status === ElectionStatus.CLOSED && new Date() < current.closesAt)
      throw new BadRequestException(
        'An election cannot be closed before its scheduled end.',
      );
    if (
      current.status === ElectionStatus.UPCOMING &&
      ![
        ElectionStatus.UPCOMING,
        ElectionStatus.OPEN,
        ElectionStatus.CLOSED,
      ].includes(status)
    )
      throw new BadRequestException(
        'An upcoming election can only remain upcoming, open at its scheduled start or close after its scheduled end.',
      );
    if (
      current.status === ElectionStatus.OPEN &&
      status !== ElectionStatus.OPEN &&
      status !== ElectionStatus.CLOSED
    )
      throw new BadRequestException(
        'An open election can only remain open or close after its scheduled end.',
      );
    if (
      current.status === ElectionStatus.CLOSED &&
      status !== ElectionStatus.CLOSED
    )
      throw new BadRequestException('A closed election cannot be reopened.');
    const updated = await this.prisma.election.update({
      where: { id },
      data: { status },
    });
    await this.audit.activity(user, {
      type: ActivityType.ELECTION,
      severity: ActivitySeverity.WARNING,
      detail: `Changed election ${current.title} status.`,
      beforeValue: current.status,
      afterValue: status,
    });
    await this.audit.electionEvent({
      user,
      electionId: id,
      action: `Changed election status from ${current.status} to ${status}.`,
    });
    if (status !== current.status)
      await this.announceStatus(id, current.title, status);
    return updated;
  }

  async publishResults(
    user: AuthenticatedUser,
    id: string,
    input: { resultHash?: unknown; bulletinRoot?: unknown; results?: unknown },
  ) {
    if (
      user.role !== UserRole.ELECTION_OFFICER &&
      user.role !== UserRole.DISPUTE_RESOLUTION_COMMITTEE &&
      user.role !== UserRole.SYSTEM_ADMINISTRATOR
    ) {
      throw new ForbiddenException(
        'Only an election officer, dispute resolution committee member or system administrator can publish results.',
      );
    }
    if (user.role === UserRole.ELECTION_OFFICER)
      await this.requireElectionPermission(user);
    const resultHash = this.hash(input.resultHash, 'resultHash');
    const bulletinRoot = this.hash(input.bulletinRoot, 'bulletinRoot');
    const current = await this.prisma.election.findUnique({
      where: { id },
      include: {
        contests: { include: { candidates: true } },
        _count: { select: { voterParticipations: true } },
      },
    });
    if (!current) throw new NotFoundException('Election was not found.');
    if (current.status !== ElectionStatus.CLOSED)
      throw new BadRequestException('Only a closed election can be published.');
    if (current.closesAt > new Date())
      throw new BadRequestException(
        'Results cannot be published before the scheduled voting window ends.',
      );
    const tallies = this.tallies(
      input.results,
      current.contests,
      current._count.voterParticipations,
    );
    const canonicalTally = JSON.stringify(
      [...tallies].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    );
    if (
      createHash('sha256').update(canonicalTally).digest('hex') !== resultHash
    )
      throw new BadRequestException(
        'resultHash does not match the supplied candidate vote totals.',
      );

    const publishedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      for (const tally of tallies) {
        await tx.candidate.update({
          where: { id: tally.candidateId },
          data: { publishedVotes: tally.votes },
        });
      }
      const changed = await tx.election.updateMany({
        where: { id, status: ElectionStatus.CLOSED },
        data: {
          status: ElectionStatus.PUBLISHED,
          publishedAt,
          resultHash,
          bulletinRoot,
        },
      });
      if (changed.count !== 1)
        throw new BadRequestException(
          'The election status changed before results could be published.',
        );
      return tx.election.findUniqueOrThrow({ where: { id } });
    });
    await this.audit.activity(user, {
      type: ActivityType.ELECTION,
      severity: ActivitySeverity.WARNING,
      detail: `Published official results for ${current.title}.`,
      beforeValue: current.status,
      afterValue: JSON.stringify({
        status: ElectionStatus.PUBLISHED,
        publishedAt,
        resultHash,
        bulletinRoot,
      }),
    });
    await this.audit.electionEvent({
      user,
      electionId: id,
      action: `Official election results published for ${current.title}.`,
    });
    await this.notifications.toEveryone({
      kind: 'result',
      title: `Results published: ${current.title}`,
      body: 'Official results are now available, with the result hash for independent verification.',
      link: `/results/${id}`,
    });
    return updated;
  }

  private hideUnpublishedTallies<
    T extends {
      status: ElectionStatus;
      contests: { candidates: { publishedVotes: number | null }[] }[];
    },
  >(election: T): T {
    if (election.status === ElectionStatus.PUBLISHED) return election;
    return {
      ...election,
      contests: election.contests.map((contest) => ({
        ...contest,
        candidates: contest.candidates.map((candidate) => ({
          ...candidate,
          publishedVotes: null,
        })),
      })),
    };
  }

  private hash(value: unknown, field: string) {
    if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value.trim())) {
      throw new BadRequestException(
        `${field} must be a 64-character SHA-256 hex digest.`,
      );
    }
    return value.trim().toLowerCase();
  }

  private publicKey(value: unknown) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(
        'publicKey is required to encrypt ballots.',
      );
    try {
      const key = createPublicKey(value);
      if (
        key.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
      )
        throw new Error('Unsupported key.');
    } catch {
      throw new BadRequestException(
        'publicKey must be a valid RSA public key of at least 3072 bits.',
      );
    }
    return value.trim();
  }

  private tallies(
    value: unknown,
    contests: {
      id: string;
      title: string;
      seats: number;
      candidates: { id: string }[];
    }[],
    ballotsCast: number,
  ) {
    if (!Array.isArray(value))
      throw new BadRequestException(
        'results must include vote totals for every candidate.',
      );
    const candidateContest = new Map<
      string,
      { contestId: string; seats: number }
    >();
    for (const contest of contests)
      for (const candidate of contest.candidates)
        candidateContest.set(candidate.id, {
          contestId: contest.id,
          seats: contest.seats,
        });
    const seen = new Set<string>();
    const totals = new Map<string, number>();
    const tallies = value.map((entry, index) => {
      if (!entry || typeof entry !== 'object')
        throw new BadRequestException(`results[${index}] is invalid.`);
      const row = entry as Record<string, unknown>;
      if (
        typeof row.candidateId !== 'string' ||
        !candidateContest.has(row.candidateId)
      )
        throw new BadRequestException(
          `results[${index}] must reference a candidate in this election.`,
        );
      if (seen.has(row.candidateId))
        throw new BadRequestException(
          `Candidate ${row.candidateId} appears more than once in results.`,
        );
      if (!Number.isSafeInteger(row.votes) || Number(row.votes) < 0)
        throw new BadRequestException(
          `results[${index}].votes must be a non-negative integer.`,
        );
      seen.add(row.candidateId);
      const candidate = candidateContest.get(row.candidateId)!;
      totals.set(
        candidate.contestId,
        (totals.get(candidate.contestId) ?? 0) + Number(row.votes),
      );
      return { candidateId: row.candidateId, votes: Number(row.votes) };
    });
    if (seen.size !== candidateContest.size)
      throw new BadRequestException(
        'Results must include every candidate in the election.',
      );
    for (const contest of contests) {
      const maximum = ballotsCast * contest.seats;
      if ((totals.get(contest.id) ?? 0) > maximum)
        throw new BadRequestException(
          `Vote totals for ${contest.title} exceed the ballot count and seat limit.`,
        );
    }
    return tallies;
  }

  private async requireElectionPermission(user: AuthenticatedUser) {
    if (user.role === UserRole.SYSTEM_ADMINISTRATOR) return;
    const permission = await this.prisma.rolePermission.findFirst({
      where: {
        role: UserRole.ELECTION_OFFICER,
        permission: 'MANAGE_ELECTIONS',
      },
    });
    if (permission && !permission.enabled)
      throw new ForbiddenException(
        'Election management is not enabled for election officers.',
      );
  }

  private contests(value: unknown) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50)
      throw new BadRequestException('Provide between 1 and 50 contests.');
    return value.map((item, index) => {
      if (!item || typeof item !== 'object')
        throw new BadRequestException(`Contest ${index + 1} is invalid.`);
      const contest = item as Record<string, unknown>;
      const title = this.required(contest.title, `contests[${index}].title`);
      const seats = contest.seats == null ? 1 : Number(contest.seats);
      if (!Number.isInteger(seats) || seats < 1 || seats > 100)
        throw new BadRequestException(
          `Contest ${index + 1} seats must be between 1 and 100.`,
        );
      return {
        title,
        description:
          typeof contest.description === 'string' ? contest.description : '',
        seats,
      };
    });
  }

  private required(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${field} is required.`);
    return value.trim();
  }

  private date(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${field} is required.`);
    const result = new Date(value);
    if (Number.isNaN(result.getTime()))
      throw new BadRequestException(`${field} must be a valid date.`);
    return result;
  }

  private enumValue<T extends string>(
    value: unknown,
    values: T[],
    field: string,
  ): T {
    const normalized = typeof value === 'string' ? value.toUpperCase() : '';
    const match = (values as string[]).find((entry) => entry === normalized);
    if (!match)
      throw new BadRequestException(`${field} has an unsupported value.`);
    return match as T;
  }
}
