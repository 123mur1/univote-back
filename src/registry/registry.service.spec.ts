import { Test } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { RegistryService } from './registry.service';

describe('RegistryService', () => {
  it('imports records in batches within an extended transaction', async () => {
    const executedQueries: string[] = [];
    const tx = {
      registryRecord: {
        count: jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(251),
        deleteMany: jest.fn(),
      },
      $executeRaw: jest.fn((query: Prisma.Sql) => {
        executedQueries.push(query.sql);
        return Promise.resolve(1);
      }),
      registryImport: { create: jest.fn() },
      activityLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const notifications = { toRoles: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        RegistryService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    const service = module.get(RegistryService);
    const user: AuthenticatedUser = {
      id: 'admin-id',
      role: UserRole.SYSTEM_ADMINISTRATOR,
      name: 'Administrator',
      email: 'admin@example.edu',
      registrationNumber: null,
    };
    const students = Array.from({ length: 251 }, (_, index) => ({
      registrationNumber: `2026/TEST/${String(index + 1).padStart(4, '0')}`,
      firstName: 'Test',
      lastName: `Student ${index + 1}`,
      college: 'Test College',
      school: 'Test School',
      department: 'Testing',
      campus: 'Test Campus',
    }));

    await expect(
      service.importRows(user, {
        mode: 'merge',
        sourceFilename: 'registry.csv',
        students,
      }),
    ).resolves.toEqual({
      success: true,
      imported: 251,
      total: 251,
      retained: 0,
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const firstBatchQuery = executedQueries[0];
    if (!firstBatchQuery)
      throw new Error('First registry batch was not executed.');
    expect(firstBatchQuery).toContain('::"Gender"');
    expect(firstBatchQuery).toContain('::"StudyLevel"');
    expect(firstBatchQuery).toContain('::"EnrolmentStatus"');
    expect(firstBatchQuery).toContain('"updatedAt"');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 120_000,
    });
    expect(notifications.toRoles).toHaveBeenCalledWith(
      [UserRole.SYSTEM_ADMINISTRATOR, UserRole.ELECTION_OFFICER],
      expect.objectContaining({ kind: 'registry' }),
    );
    await module.close();
  });
});
