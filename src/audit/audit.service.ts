import { Injectable } from '@nestjs/common';
import { ActivityActorRole, ActivitySeverity, ActivityType, ElectionAuditRole, UserRole } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async activity(user: AuthenticatedUser, input: { type: ActivityType; severity?: ActivitySeverity; detail: string; beforeValue?: string; afterValue?: string }) {
    return this.prisma.activityLog.create({
      data: {
        actorId: user.id,
        actorLabel: user.registrationNumber ?? user.email ?? user.name,
        actorRole: this.activityRole(user.role),
        severity: input.severity ?? ActivitySeverity.INFO,
        type: input.type,
        detail: input.detail,
        beforeValue: input.beforeValue,
        afterValue: input.afterValue,
      },
    });
  }

  async electionEvent(input: { user?: AuthenticatedUser; actorLabel?: string; electionId?: string; action: string; role?: ElectionAuditRole }) {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.electionAuditEntry.findFirst({ orderBy: { sequence: 'desc' } });
      const previousHash = previous?.hash ?? 'GENESIS';
      const occurredAt = new Date();
      const actorLabel = input.actorLabel ?? input.user?.registrationNumber ?? input.user?.email ?? input.user?.name ?? 'system';
      const role = input.role ?? this.auditRole(input.user?.role);
      const content = JSON.stringify({ previousHash, electionId: input.electionId ?? null, actorLabel, role, action: input.action, occurredAt: occurredAt.toISOString() });
      const hash = createHash('sha256').update(content).digest('hex');
      return tx.electionAuditEntry.create({
        data: {
          previousHash,
          hash,
          electionId: input.electionId,
          actorId: input.user?.id,
          actorLabel,
          role,
          action: input.action,
          occurredAt,
        },
      });
    }, { isolationLevel: 'Serializable' });
  }

  async electionLog(electionId?: string, take = 100) {
    return this.prisma.electionAuditEntry.findMany({ where: electionId ? { electionId } : {}, orderBy: { sequence: 'desc' }, take });
  }

  async activityLog(take = 100) {
    return this.prisma.activityLog.findMany({ orderBy: { occurredAt: 'desc' }, take });
  }

  private activityRole(role: UserRole) {
    if (role === UserRole.STUDENT) return ActivityActorRole.STUDENT;
    if (role === UserRole.ELECTION_OFFICER) return ActivityActorRole.ELECTION_OFFICER;
    if (role === UserRole.DISPUTE_RESOLUTION_COMMITTEE) return ActivityActorRole.DISPUTE_RESOLUTION_COMMITTEE;
    return ActivityActorRole.ADMINISTRATOR;
  }

  private auditRole(role?: UserRole): ElectionAuditRole {
    if (role === UserRole.STUDENT) return ElectionAuditRole.VOTER;
    if (role === UserRole.ELECTION_OFFICER) return ElectionAuditRole.ELECTION_OFFICER;
    if (role === UserRole.DISPUTE_RESOLUTION_COMMITTEE) return ElectionAuditRole.DISPUTE_RESOLUTION_COMMITTEE;
    if (role === UserRole.SYSTEM_ADMINISTRATOR) return ElectionAuditRole.ADMINISTRATOR;
    return ElectionAuditRole.SYSTEM;
  }
}
