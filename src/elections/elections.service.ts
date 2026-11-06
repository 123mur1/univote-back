import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivitySeverity, ActivityType, ElectionScopeLevel, ElectionStatus, ElectionAuditRole, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';

type CreateElectionInput = {
  title?: unknown;
  description?: unknown;
  scopeLevel?: unknown;
  scopeValue?: unknown;
  opensAt?: unknown;
  closesAt?: unknown;
  closesOn?: unknown;
  contests?: unknown;
};

@Injectable()
export class ElectionsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list() {
    return this.prisma.election.findMany({
      include: { contests: { orderBy: { sortOrder: 'asc' }, include: { candidates: { orderBy: { name: 'asc' } } } }, _count: { select: { encryptedBallots: true, voterParticipations: true } } },
      orderBy: { opensAt: 'desc' },
    });
  }

  async get(id: string) {
    const election = await this.prisma.election.findUnique({
      where: { id },
      include: { contests: { orderBy: { sortOrder: 'asc' }, include: { candidates: { orderBy: { name: 'asc' } } } }, _count: { select: { encryptedBallots: true, voterParticipations: true } } },
    });
    if (!election) throw new NotFoundException('Election was not found.');
    return election;
  }

  async create(user: AuthenticatedUser, input: CreateElectionInput) {
    await this.requireElectionPermission(user);
    const title = this.required(input.title, 'title');
    const scopeLevel = this.enumValue(input.scopeLevel, Object.values(ElectionScopeLevel), 'scopeLevel');
    const scopeValue = typeof input.scopeValue === 'string' && input.scopeValue.trim() ? input.scopeValue.trim() : null;
    if (scopeLevel !== ElectionScopeLevel.UNIVERSITY && !scopeValue) throw new BadRequestException('scopeValue is required for a scoped election.');
    const opensAt = this.date(input.opensAt, 'opensAt');
    const closesAt = this.date(input.closesAt, 'closesAt');
    const closesOn = this.date(input.closesOn ?? closesAt.toISOString(), 'closesOn');
    if (closesAt <= opensAt) throw new BadRequestException('closesAt must be after opensAt.');
    const contests = this.contests(input.contests);

    const election = await this.prisma.election.create({
      data: {
        title,
        description: typeof input.description === 'string' ? input.description.trim() : null,
        scopeLevel,
        scopeValue,
        opensAt,
        closesAt,
        closesOn,
        status: opensAt > new Date() ? ElectionStatus.UPCOMING : ElectionStatus.OPEN,
        createdById: user.id,
        contests: { create: contests.map((contest, sortOrder) => ({ ...contest, sortOrder })) },
      },
      include: { contests: true },
    });
    await this.audit.activity(user, { type: ActivityType.ELECTION, severity: ActivitySeverity.INFO, detail: `Created election draft ${title}.`, beforeValue: 'No election', afterValue: JSON.stringify({ title, scopeLevel, scopeValue, opensAt, closesAt, contests }) });
    await this.audit.electionEvent({ user, electionId: election.id, action: `Created election draft: ${title}.` });
    return election;
  }

  async updateStatus(user: AuthenticatedUser, id: string, statusValue: unknown) {
    await this.requireElectionPermission(user);
    const status = this.enumValue(statusValue, Object.values(ElectionStatus), 'status');
    const current = await this.get(id);
    if (current.status === ElectionStatus.PUBLISHED && status !== ElectionStatus.PUBLISHED) throw new BadRequestException('A published election cannot be reopened or changed.');
    if (status === ElectionStatus.PUBLISHED && current.status !== ElectionStatus.CLOSED) throw new BadRequestException('Close an election before publishing results.');
    const updated = await this.prisma.election.update({ where: { id }, data: { status, publishedAt: status === ElectionStatus.PUBLISHED ? new Date() : undefined } });
    await this.audit.activity(user, { type: ActivityType.ELECTION, severity: ActivitySeverity.WARNING, detail: `Changed election ${current.title} status.`, beforeValue: current.status, afterValue: status });
    await this.audit.electionEvent({ user, electionId: id, action: `Changed election status from ${current.status} to ${status}.` });
    return updated;
  }

  private async requireElectionPermission(user: AuthenticatedUser) {
    if (user.role === UserRole.SYSTEM_ADMINISTRATOR) return;
    const permission = await this.prisma.rolePermission.findFirst({ where: { role: UserRole.ELECTION_OFFICER, permission: 'MANAGE_ELECTIONS' } });
    if (permission && !permission.enabled) throw new ForbiddenException('Election management is not enabled for election officers.');
  }

  private contests(value: unknown) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new BadRequestException('Provide between 1 and 50 contests.');
    return value.map((item, index) => {
      if (!item || typeof item !== 'object') throw new BadRequestException(`Contest ${index + 1} is invalid.`);
      const contest = item as Record<string, unknown>;
      const title = this.required(contest.title, `contests[${index}].title`);
      const seats = contest.seats == null ? 1 : Number(contest.seats);
      if (!Number.isInteger(seats) || seats < 1 || seats > 100) throw new BadRequestException(`Contest ${index + 1} seats must be between 1 and 100.`);
      return { title, description: typeof contest.description === 'string' ? contest.description : '', seats };
    });
  }

  private required(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
    return value.trim();
  }

  private date(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
    const result = new Date(value);
    if (Number.isNaN(result.getTime())) throw new BadRequestException(`${field} must be a valid date.`);
    return result;
  }

  private enumValue<T extends string>(value: unknown, values: T[], field: string): T {
    const normalized = typeof value === 'string' ? value.toUpperCase() : '';
    const match = (values as string[]).find((entry) => entry === normalized);
    if (!match) throw new BadRequestException(`${field} has an unsupported value.`);
    return match as T;
  }
}
