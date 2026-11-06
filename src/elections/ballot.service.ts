import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivitySeverity, ActivityType, ElectionAuditRole, ElectionScopeLevel, ElectionStatus, UserRole, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class BallotService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async cast(user: AuthenticatedUser, electionId: string, payloadValue: unknown) {
    if (user.role !== UserRole.STUDENT || !user.registrationNumber) throw new ForbiddenException('A student account is required to vote.');
    if (typeof payloadValue !== 'string' || !payloadValue.trim() || payloadValue.length > 1_000_000) throw new BadRequestException('Encrypted ballot payload is required and must be under 1 MB.');
    const election = await this.prisma.election.findUnique({ where: { id: electionId } });
    if (!election) throw new NotFoundException('Election was not found.');
    const now = new Date();
    if (election.status !== ElectionStatus.OPEN || now < election.opensAt || now > election.closesAt) throw new ConflictException('This election is not currently open for voting.');
    const student = await this.prisma.registryRecord.findUnique({ where: { registrationNumber: user.registrationNumber } });
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
    if (!student || student.enrolment !== 'ACTIVE' || (student.registeredAcademicYear && student.registeredAcademicYear !== (settings?.academicYearLabel ?? '2026/2027')) || (student.studyEnd && student.studyEnd < election.closesOn)) {
      throw new ForbiddenException('The student is not eligible according to the current registry record.');
    }
    const inScope = election.scopeLevel === ElectionScopeLevel.UNIVERSITY
      || (election.scopeLevel === ElectionScopeLevel.COLLEGE && (student.collegeCode === election.scopeValue || student.college === election.scopeValue))
      || (election.scopeLevel === ElectionScopeLevel.SCHOOL && student.school === election.scopeValue)
      || (election.scopeLevel === ElectionScopeLevel.DEPARTMENT && student.department === election.scopeValue)
      || (election.scopeLevel === ElectionScopeLevel.CAMPUS && student.campus === election.scopeValue);
    if (!inScope) throw new ForbiddenException('The student is outside this election’s voting scope.');

    const receiptHash = createHash('sha256').update(`${electionId}:${randomBytes(32).toString('hex')}:${payloadValue}`).digest('hex');
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.voterParticipation.create({ data: { electionId, studentRegistrationNo: student.registrationNumber, userId: user.id } });
        await tx.encryptedBallot.create({ data: { electionId, encryptedPayload: payloadValue, receiptHash } });
        await tx.activityLog.create({ data: { actorId: user.id, actorLabel: student.registrationNumber, actorRole: 'STUDENT', type: ActivityType.VOTE, severity: ActivitySeverity.INFO, detail: `Ballot cast in ${election.title}.`, beforeValue: 'No participation recorded', afterValue: 'Ballot accepted; selections encrypted' } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('A ballot has already been recorded for this election.');
      throw error;
    }
    await this.audit.electionEvent({ electionId, action: `A voter cast a ballot in ${election.title}.`, actorLabel: 'anonymous voter', role: ElectionAuditRole.VOTER });
    return { accepted: true, receipt: receiptHash, castAt: new Date().toISOString() };
  }

  async verifyReceipt(receipt: string) {
    const ballot = await this.prisma.encryptedBallot.findUnique({ where: { receiptHash: receipt }, select: { receiptHash: true, castAt: true, election: { select: { id: true, title: true } } } });
    if (!ballot) throw new NotFoundException('No ballot matches this receipt.');
    return { valid: true, receipt: ballot.receiptHash, recordedAt: ballot.castAt, election: ballot.election };
  }
}
