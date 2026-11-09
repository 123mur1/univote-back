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
  ElectionAuditRole,
  ElectionScopeLevel,
  ElectionStatus,
  UserRole,
  Prisma,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class BallotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async cast(
    user: AuthenticatedUser,
    electionId: string,
    payloadValue: unknown,
  ) {
    if (user.role !== UserRole.STUDENT || !user.registrationNumber)
      throw new ForbiddenException('A student account is required to vote.');
    if (
      typeof payloadValue !== 'string' ||
      !payloadValue.trim() ||
      payloadValue.length > 1_000_000
    )
      throw new BadRequestException(
        'Encrypted ballot payload is required and must be under 1 MB.',
      );
    let encrypted: Record<string, unknown>;
    try {
      encrypted = JSON.parse(payloadValue) as Record<string, unknown>;
    } catch {
      throw new BadRequestException(
        'Ballot payload must use the supported encryption envelope.',
      );
    }
    if (
      encrypted.version !== 'RSA-OAEP-256+A256GCM' ||
      typeof encrypted.wrappedKey !== 'string' ||
      typeof encrypted.iv !== 'string' ||
      typeof encrypted.ciphertext !== 'string'
    ) {
      throw new BadRequestException(
        'Ballot payload must use the supported encryption envelope.',
      );
    }
    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
    });
    if (!election) throw new NotFoundException('Election was not found.');
    if (!election.publicKey)
      throw new ConflictException(
        'This election does not have a ballot encryption key.',
      );
    const modulusLength =
      createPublicKey(election.publicKey).asymmetricKeyDetails?.modulusLength ??
      0;
    if (
      Buffer.from(encrypted.wrappedKey, 'base64url').length !==
        modulusLength / 8 ||
      Buffer.from(encrypted.iv, 'base64url').length !== 12 ||
      Buffer.from(encrypted.ciphertext, 'base64url').length < 17
    ) {
      throw new BadRequestException(
        'Encrypted ballot payload has invalid cryptographic fields.',
      );
    }
    const now = new Date();
    if (
      election.status !== ElectionStatus.OPEN ||
      now < election.opensAt ||
      now > election.closesAt
    )
      throw new ConflictException(
        'This election is not currently open for voting.',
      );
    const student = await this.prisma.registryRecord.findUnique({
      where: { registrationNumber: user.registrationNumber },
    });
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
    });
    if (
      !student ||
      student.enrolment !== 'ACTIVE' ||
      (student.registeredAcademicYear &&
        student.registeredAcademicYear !==
          (settings?.academicYearLabel ?? '2026/2027')) ||
      (student.studyEnd && student.studyEnd < election.closesOn)
    ) {
      throw new ForbiddenException(
        'The student is not eligible according to the current registry record.',
      );
    }
    const inScope =
      election.scopeLevel === ElectionScopeLevel.UNIVERSITY ||
      (election.scopeLevel === ElectionScopeLevel.COLLEGE &&
        (student.collegeCode === election.scopeValue ||
          student.college === election.scopeValue)) ||
      (election.scopeLevel === ElectionScopeLevel.SCHOOL &&
        student.school === election.scopeValue) ||
      (election.scopeLevel === ElectionScopeLevel.DEPARTMENT &&
        student.department === election.scopeValue) ||
      (election.scopeLevel === ElectionScopeLevel.CAMPUS &&
        student.campus === election.scopeValue);
    if (!inScope)
      throw new ForbiddenException(
        'The student is outside this election’s voting scope.',
      );

    const receiptHash = createHash('sha256')
      .update(
        `${electionId}:${randomBytes(32).toString('hex')}:${payloadValue}`,
      )
      .digest('hex');
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.voterParticipation.create({
          data: {
            electionId,
            studentRegistrationNo: student.registrationNumber,
            userId: user.id,
          },
        });
        await tx.encryptedBallot.create({
          data: { electionId, encryptedPayload: payloadValue, receiptHash },
        });
        await tx.activityLog.create({
          data: {
            actorId: user.id,
            actorLabel: student.registrationNumber,
            actorRole: 'STUDENT',
            type: ActivityType.VOTE,
            severity: ActivitySeverity.INFO,
            detail: `Ballot cast in ${election.title}.`,
            beforeValue: 'No participation recorded',
            afterValue: 'Ballot accepted; selections encrypted',
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'A ballot has already been recorded for this election.',
        );
      throw error;
    }
    await this.audit.electionEvent({
      electionId,
      action: `A voter cast a ballot in ${election.title}.`,
      actorLabel: 'anonymous voter',
      role: ElectionAuditRole.VOTER,
    });
    return {
      accepted: true,
      receipt: receiptHash,
      castAt: new Date().toISOString(),
    };
  }

  async participation(user: AuthenticatedUser, electionId: string) {
    if (!user.registrationNumber)
      throw new ForbiddenException('A student account is required.');
    const voted = await this.prisma.voterParticipation.findUnique({
      where: {
        electionId_studentRegistrationNo: {
          electionId,
          studentRegistrationNo: user.registrationNumber,
        },
      },
      select: { castAt: true },
    });
    return { voted: Boolean(voted), castAt: voted?.castAt ?? null };
  }

  async eligibility(user: AuthenticatedUser, electionId: string) {
    if (!user.registrationNumber)
      throw new ForbiddenException('A student account is required.');
    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
    });
    if (!election) throw new NotFoundException('Election was not found.');
    const student = await this.prisma.registryRecord.findUnique({
      where: { registrationNumber: user.registrationNumber },
    });
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
    });
    const registered = Boolean(
      student &&
      student.enrolment === 'ACTIVE' &&
      (!student.registeredAcademicYear ||
        student.registeredAcademicYear ===
          (settings?.academicYearLabel ?? '2026/2027')) &&
      (!student.studyEnd || student.studyEnd >= election.closesOn),
    );
    const inScope = Boolean(
      student &&
      (election.scopeLevel === ElectionScopeLevel.UNIVERSITY ||
        (election.scopeLevel === ElectionScopeLevel.COLLEGE &&
          (student.collegeCode === election.scopeValue ||
            student.college === election.scopeValue)) ||
        (election.scopeLevel === ElectionScopeLevel.SCHOOL &&
          student.school === election.scopeValue) ||
        (election.scopeLevel === ElectionScopeLevel.DEPARTMENT &&
          student.department === election.scopeValue) ||
        (election.scopeLevel === ElectionScopeLevel.CAMPUS &&
          student.campus === election.scopeValue)),
    );
    const participation = await this.prisma.voterParticipation.findUnique({
      where: {
        electionId_studentRegistrationNo: {
          electionId,
          studentRegistrationNo: user.registrationNumber,
        },
      },
    });
    const open =
      election.status === ElectionStatus.OPEN &&
      new Date() >= election.opensAt &&
      new Date() <= election.closesAt;
    const checks = [
      {
        id: 'registry',
        label: 'Active registry record',
        pass: registered,
        detail: registered
          ? 'Registry and academic year checks passed.'
          : 'The current registry record is missing or not eligible.',
      },
      {
        id: 'scope',
        label: 'Within election scope',
        pass: inScope,
        detail: inScope
          ? 'Your registry record is in this election scope.'
          : 'Your registry record is outside this election scope.',
      },
      {
        id: 'window',
        label: 'Voting is open',
        pass: open,
        detail: open
          ? 'The voting window is open.'
          : 'This election is not currently accepting ballots.',
      },
      {
        id: 'voted',
        label: 'Has not voted yet',
        pass: !participation,
        detail: participation
          ? 'A ballot was already recorded for this election.'
          : 'No ballot has been recorded yet.',
      },
    ];
    return {
      eligible: checks.every((check) => check.pass),
      voted: Boolean(participation),
      checks,
    };
  }

  async verifyReceipt(receipt: string) {
    const ballot = await this.prisma.encryptedBallot.findUnique({
      where: { receiptHash: receipt },
      select: {
        receiptHash: true,
        castAt: true,
        election: { select: { id: true, title: true } },
      },
    });
    if (!ballot) throw new NotFoundException('No ballot matches this receipt.');
    return {
      valid: true,
      receipt: ballot.receiptHash,
      recordedAt: ballot.castAt,
      election: ballot.election,
    };
  }
}
