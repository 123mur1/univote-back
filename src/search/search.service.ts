import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

export type SearchHit = {
  type: 'election' | 'candidate' | 'student' | 'nomination' | 'user';
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

// One search box for every portal. Each role only searches what it is allowed to see, and each
// result links to the page in that role's portal.
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(user: AuthenticatedUser, raw: string | undefined) {
    const q = raw?.trim() ?? '';
    if (q.length < 2) return { query: q, results: [] as SearchHit[] };
    const like = { contains: q, mode: 'insensitive' as const };
    const staff =
      user.role === UserRole.ELECTION_OFFICER ||
      user.role === UserRole.SYSTEM_ADMINISTRATOR;
    const admin = user.role === UserRole.SYSTEM_ADMINISTRATOR;
    const portal = user.role === UserRole.STUDENT ? '/student' : '/officer';
    const results: SearchHit[] = [];

    const [elections, candidates] = await Promise.all([
      this.prisma.election.findMany({
        where: { OR: [{ title: like }, { scopeValue: like }] },
        take: 5,
        orderBy: { opensAt: 'desc' },
      }),
      this.prisma.candidate.findMany({
        where: { OR: [{ name: like }, { programme: like }] },
        take: 5,
        include: { contest: { include: { election: true } } },
      }),
    ]);
    for (const election of elections)
      results.push({
        type: 'election',
        id: election.id,
        title: election.title,
        subtitle: `${election.status.toLowerCase()} · ${election.scopeValue ?? 'University-wide'}`,
        href: `${portal}/elections/${election.id}`,
      });
    for (const candidate of candidates)
      results.push({
        type: 'candidate',
        id: candidate.id,
        title: candidate.name,
        subtitle: `${candidate.contest.title} · ${candidate.contest.election.title}`,
        href: `${portal}/elections/${candidate.contest.electionId}`,
      });

    if (staff) {
      const [students, nominations] = await Promise.all([
        this.prisma.registryRecord.findMany({
          where: {
            OR: [
              { registrationNumber: like },
              { firstName: like },
              { lastName: like },
              { department: like },
            ],
          },
          take: 6,
        }),
        this.prisma.nomination.findMany({
          where: { OR: [{ name: like }, { studentRegistrationNo: like }] },
          take: 5,
          include: { contest: true },
        }),
      ]);
      for (const student of students)
        results.push({
          type: 'student',
          id: student.registrationNumber,
          title: `${student.firstName} ${student.lastName}`,
          subtitle: `${student.registrationNumber} · ${student.department} · ${student.enrolment.toLowerCase()}`,
          href: `${admin ? '/admin' : '/officer'}/registry?q=${encodeURIComponent(student.registrationNumber)}`,
        });
      for (const nomination of nominations)
        results.push({
          type: 'nomination',
          id: nomination.id,
          title: nomination.name,
          subtitle: `Application · ${nomination.contest.title} · ${nomination.status.toLowerCase()}`,
          href: `/officer/candidates/${nomination.id}`,
        });
    }

    if (admin) {
      const users = await this.prisma.user.findMany({
        where: {
          OR: [{ name: like }, { email: like }, { registrationNumber: like }],
        },
        take: 6,
      });
      for (const account of users)
        results.push({
          type: 'user',
          id: account.id,
          title: account.name,
          subtitle: `${account.role.replace(/_/g, ' ').toLowerCase()} · ${account.registrationNumber ?? account.email ?? ''}${account.active ? '' : ' · suspended'}`,
          href: `/admin/users?q=${encodeURIComponent(account.registrationNumber ?? account.email ?? account.name)}`,
        });
    }
    return { query: q, results };
  }
}
