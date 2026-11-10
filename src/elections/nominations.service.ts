import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivitySeverity,
  ActivityType,
  DocumentKind,
  DocumentReviewStatus,
  ElectionAuditRole,
  ElectionScopeLevel,
  ElectionStatus,
  NominationReviewAction,
  NominationStatus,
  UserRole,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class NominationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async submit(user: AuthenticatedUser, body: Record<string, unknown>) {
    if (user.role !== UserRole.STUDENT || !user.registrationNumber)
      throw new ForbiddenException(
        'A student account is required to nominate a candidate.',
      );
    const contestId = this.required(body.contestId, 'contestId');
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      include: { election: true },
    });
    if (!contest) throw new NotFoundException('Position was not found.');
    if (
      contest.election.status !== ElectionStatus.UPCOMING &&
      contest.election.status !== ElectionStatus.OPEN
    )
      throw new BadRequestException(
        'Nominations are closed for this election.',
      );
    if (
      contest.election.nominationsClose &&
      contest.election.nominationsClose <
        new Date(new Date().toISOString().slice(0, 10))
    )
      throw new BadRequestException('The nomination deadline has passed.');
    const student = await this.prisma.registryRecord.findUnique({
      where: { registrationNumber: user.registrationNumber },
    });
    if (!student || student.enrolment !== 'ACTIVE')
      throw new ForbiddenException('The registry record is not active.');
    if (student.cumulativeGpa === null || Number(student.cumulativeGpa) < 2.5)
      throw new ForbiddenException(
        'A verified cumulative GPA of at least 2.5 is required to nominate.',
      );
    if (student.openDisciplinaryCase !== false)
      throw new ForbiddenException(
        'The registry must confirm there is no open disciplinary case before nomination.',
      );
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
    });
    if (
      student.registeredAcademicYear &&
      student.registeredAcademicYear !==
        (settings?.academicYearLabel ?? '2026/2027')
    )
      throw new ForbiddenException(
        'The student is not registered for the current academic year.',
      );
    if (student.studyEnd && student.studyEnd < new Date())
      throw new ForbiddenException('The student study period has ended.');
    const inScope =
      contest.election.scopeLevel === ElectionScopeLevel.UNIVERSITY ||
      (contest.election.scopeLevel === ElectionScopeLevel.COLLEGE &&
        (student.collegeCode === contest.election.scopeValue ||
          student.college === contest.election.scopeValue)) ||
      (contest.election.scopeLevel === ElectionScopeLevel.SCHOOL &&
        student.school === contest.election.scopeValue) ||
      (contest.election.scopeLevel === ElectionScopeLevel.DEPARTMENT &&
        student.department === contest.election.scopeValue) ||
      (contest.election.scopeLevel === ElectionScopeLevel.CAMPUS &&
        student.campus === contest.election.scopeValue);
    if (!inScope)
      throw new ForbiddenException(
        'The student is outside this position’s election scope.',
      );

    const documentsInput = Array.isArray(body.documents)
      ? (body.documents as Record<string, unknown>[])
      : [];
    if (documentsInput.length > 10)
      throw new BadRequestException(
        'A nomination can include at most 10 documents.',
      );
    const documentData = documentsInput.map((document, index) => ({
      kind: this.enumValue(
        document.kind,
        Object.values(DocumentKind),
        `documents[${index}].kind`,
      ),
      name: this.required(document.name, `documents[${index}].name`),
      storageKey: this.required(
        document.storageKey,
        `documents[${index}].storageKey`,
      ),
      mimeType:
        typeof document.mimeType === 'string' ? document.mimeType : null,
      sizeBytes:
        document.sizeBytes == null
          ? null
          : this.int(
              document.sizeBytes,
              `documents[${index}].sizeBytes`,
              1,
              10 * 1024 * 1024,
            ),
    }));
    const name = this.required(
      body.name ?? `${student.firstName} ${student.lastName}`,
      'name',
    );
    const email =
      typeof body.email === 'string'
        ? body.email.trim()
        : (student.email ?? '');
    const phone = this.required(body.phone, 'phone');
    const manifesto = this.required(body.manifesto, 'manifesto');
    const declaredSnapshot = this.json(
      body.declaredSnapshot ?? {},
      'declaredSnapshot',
    );
    const registrySnapshot = this.json(
      {
        registrationNumber: student.registrationNumber,
        firstName: student.firstName,
        lastName: student.lastName,
        college: student.college,
        school: student.school,
        department: student.department,
        campus: student.campus,
        enrolment: student.enrolment,
        registeredAcademicYear: student.registeredAcademicYear,
        cumulativeGpa: student.cumulativeGpa?.toString() ?? null,
        openDisciplinaryCase: student.openDisciplinaryCase,
      },
      'registrySnapshot',
    );
    const exists = await this.prisma.nomination.findFirst({
      where: { contestId, studentRegistrationNo: student.registrationNumber },
    });
    if (exists)
      throw new BadRequestException(
        'A nomination has already been submitted for this position.',
      );

    const nomination = await this.prisma.nomination.create({
      data: {
        electionId: contest.electionId,
        contestId,
        studentRegistrationNo: student.registrationNumber,
        submittedById: user.id,
        name,
        email,
        phone,
        slogan: typeof body.slogan === 'string' ? body.slogan.trim() : '',
        manifesto,
        electionFaculty:
          typeof body.electionFaculty === 'string'
            ? body.electionFaculty
            : null,
        declaredSnapshot,
        registrySnapshot,
        documents: { create: documentData },
      },
      include: { documents: true },
    });
    await this.audit.activity(user, {
      type: ActivityType.NOMINATION,
      detail: `Submitted a nomination for ${contest.title}.`,
      beforeValue: 'No nomination',
      afterValue: 'Pending officer review',
    });
    await this.audit.electionEvent({
      user,
      electionId: contest.electionId,
      action: `Candidate nomination submitted for ${contest.title}.`,
    });
    await this.notifications.toRoles([UserRole.ELECTION_OFFICER], {
      kind: 'nomination',
      title: 'New candidate application',
      body: `${name} applied for ${contest.title} in ${contest.election.title}.`,
      link: `/officer/candidates/${nomination.id}`,
    });
    await this.notifications.toUser(user.id, {
      kind: 'nomination',
      title: 'Application received',
      body: `Your application for ${contest.title} is waiting for review by the Electoral Commission.`,
      link: '/student/apply',
    });
    return nomination;
  }

  async list(user: AuthenticatedUser, status?: string) {
    await this.requireReviewPermission(user);
    const filter = status
      ? this.enumValue(status, Object.values(NominationStatus), 'status')
      : undefined;
    return this.prisma.nomination.findMany({
      where: filter ? { status: filter } : {},
      include: {
        documents: { include: { reviews: true } },
        contest: true,
        election: true,
      },
      orderBy: { submittedAt: 'desc' },
    });
  }

  async mine(user: AuthenticatedUser) {
    if (!user.registrationNumber)
      throw new ForbiddenException('Student account required.');
    return this.prisma.nomination.findMany({
      where: { studentRegistrationNo: user.registrationNumber },
      include: { documents: true, contest: true, election: true },
      orderBy: { submittedAt: 'desc' },
    });
  }

  async decide(
    user: AuthenticatedUser,
    id: string,
    body: { status?: unknown; note?: unknown },
  ) {
    await this.requireReviewPermission(user);
    const nomination = await this.prisma.nomination.findUnique({
      where: { id },
      include: { contest: true, documents: true, student: true },
    });
    if (!nomination) throw new NotFoundException('Nomination was not found.');
    const next = this.enumValue(
      body.status,
      [NominationStatus.APPROVED, NominationStatus.REJECTED],
      'status',
    );
    if (nomination.status !== NominationStatus.PENDING)
      throw new BadRequestException('Only pending nominations can be decided.');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (next === NominationStatus.REJECTED && note.length < 10)
      throw new BadRequestException(
        'A rejection reason of at least 10 characters is required.',
      );
    const approvedPhoto = nomination.documents.find(
      (document) => document.kind === DocumentKind.PHOTO,
    )?.storageKey;
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.nomination.update({
        where: { id },
        data: {
          status: next,
          decisionNote: note || null,
          decidedAt: new Date(),
          decidedById: user.id,
        },
      });
      await tx.nominationReview.create({
        data: {
          nominationId: id,
          reviewerId: user.id,
          action:
            next === NominationStatus.APPROVED
              ? NominationReviewAction.APPROVED
              : NominationReviewAction.REJECTED,
          previousData: { status: nomination.status },
          newData: { status: next },
          note: note || null,
        },
      });
      if (next === NominationStatus.APPROVED) {
        await tx.candidate.upsert({
          where: { nominationId: id },
          create: {
            nominationId: id,
            contestId: nomination.contestId,
            name: nomination.name,
            photoUrl: approvedPhoto,
            programme:
              nomination.student.programme ?? nomination.student.department,
            year: nomination.student.yearOfStudy
              ? `Year ${nomination.student.yearOfStudy}`
              : '',
            manifesto: nomination.manifesto,
          },
          update: {
            name: nomination.name,
            photoUrl: approvedPhoto,
            manifesto: nomination.manifesto,
          },
        });
      }
      return changed;
    });
    await this.audit.activity(user, {
      type: ActivityType.REVIEW,
      severity: ActivitySeverity.INFO,
      detail: `${next === NominationStatus.APPROVED ? 'Approved' : 'Rejected'} ${nomination.name} for ${nomination.contest.title}.`,
      beforeValue: nomination.status,
      afterValue: `${next}${note ? `: ${note}` : ''}`,
    });
    await this.audit.electionEvent({
      user,
      electionId: nomination.electionId,
      action: `${next === NominationStatus.APPROVED ? 'Approved' : 'Rejected'} a candidate nomination for ${nomination.contest.title}.`,
    });
    const approved = next === NominationStatus.APPROVED;
    await this.notifications.toUser(nomination.submittedById, {
      kind: 'nomination',
      title: approved
        ? `You are a candidate for ${nomination.contest.title}`
        : `Application not approved: ${nomination.contest.title}`,
      body: approved
        ? 'Your application was approved. You now appear on the ballot.'
        : `Reason given by the Electoral Commission: ${note}`,
      link: '/student',
    });
    return updated;
  }

  async reopen(user: AuthenticatedUser, id: string) {
    await this.requireReviewPermission(user);
    const nomination = await this.prisma.nomination.findUnique({
      where: { id },
      include: { contest: true },
    });
    if (!nomination) throw new NotFoundException('Nomination was not found.');
    if (
      nomination.electionId &&
      (
        await this.prisma.election.findUnique({
          where: { id: nomination.electionId },
        })
      )?.status !== ElectionStatus.UPCOMING
    ) {
      throw new BadRequestException(
        'A nomination can only be reopened before voting starts.',
      );
    }
    if (nomination.status === NominationStatus.PENDING)
      throw new BadRequestException(
        'This nomination is already pending review.',
      );
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.nomination.update({
        where: { id },
        data: {
          status: NominationStatus.PENDING,
          decisionNote: null,
          decidedAt: null,
          decidedById: null,
        },
      });
      await tx.candidate.deleteMany({ where: { nominationId: id } });
      await tx.nominationReview.create({
        data: {
          nominationId: id,
          reviewerId: user.id,
          action: NominationReviewAction.REOPENED,
          previousData: { status: nomination.status },
          newData: { status: NominationStatus.PENDING },
        },
      });
      return changed;
    });
    await this.audit.activity(user, {
      type: ActivityType.REVIEW,
      severity: ActivitySeverity.WARNING,
      detail: `Reopened ${nomination.name}'s nomination for ${nomination.contest.title}.`,
      beforeValue: nomination.status,
      afterValue: NominationStatus.PENDING,
    });
    await this.audit.electionEvent({
      user,
      electionId: nomination.electionId,
      action: `Reopened a candidate nomination for ${nomination.contest.title}.`,
    });
    return updated;
  }

  async reviewDocument(
    user: AuthenticatedUser,
    nominationId: string,
    documentId: string,
    body: { status?: unknown; note?: unknown },
  ) {
    await this.requireReviewPermission(user);
    const document = await this.prisma.nominationDocument.findFirst({
      where: { id: documentId, nominationId },
      include: { nomination: true },
    });
    if (!document)
      throw new NotFoundException('Nomination document was not found.');
    const status = this.enumValue(
      body.status,
      Object.values(DocumentReviewStatus),
      'status',
    );
    const note = typeof body.note === 'string' ? body.note.trim() : null;
    const review = await this.prisma.nominationDocumentReview.create({
      data: { documentId, reviewerId: user.id, status, note },
    });
    await this.prisma.nominationReview.create({
      data: {
        nominationId,
        reviewerId: user.id,
        action:
          status === DocumentReviewStatus.VERIFIED
            ? NominationReviewAction.DOCUMENT_VERIFIED
            : NominationReviewAction.DOCUMENT_FLAGGED,
        newData: { documentId, status, note },
      },
    });
    await this.audit.activity(user, {
      type: ActivityType.REVIEW,
      detail: `${status === DocumentReviewStatus.VERIFIED ? 'Verified' : 'Flagged'} ${document.name}.`,
      beforeValue: 'Not reviewed',
      afterValue: `${status}${note ? `: ${note}` : ''}`,
    });
    await this.audit.electionEvent({
      user,
      electionId: document.nomination.electionId,
      action: `${status === DocumentReviewStatus.VERIFIED ? 'Verified' : 'Flagged'} a nomination document.`,
    });
    return review;
  }

  private async requireReviewPermission(user: AuthenticatedUser) {
    if (user.role === UserRole.SYSTEM_ADMINISTRATOR) return;
    const permission = await this.prisma.rolePermission.findFirst({
      where: {
        role: UserRole.ELECTION_OFFICER,
        permission: 'REVIEW_CANDIDATES',
      },
    });
    if (permission && !permission.enabled)
      throw new ForbiddenException(
        'Candidate review is not enabled for election officers.',
      );
  }

  private required(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${field} is required.`);
    return value.trim();
  }

  private enumValue<T extends string>(
    value: unknown,
    values: T[],
    field: string,
  ): T {
    const normalized = typeof value === 'string' ? value.toUpperCase() : '';
    const match = (values as string[]).find((item) => item === normalized);
    if (!match) throw new BadRequestException(`${field} is invalid.`);
    return match as T;
  }

  private int(value: unknown, field: string, min: number, max: number) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max)
      throw new BadRequestException(
        `${field} must be an integer between ${min} and ${max}.`,
      );
    return number;
  }

  private json(value: unknown, field: string): Prisma.InputJsonValue {
    if (value == null || typeof value !== 'object')
      throw new BadRequestException(`${field} must be a JSON object.`);
    return value;
  }
}
