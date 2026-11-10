import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

export type NotificationKind =
  'election' | 'result' | 'nomination' | 'account' | 'registry' | 'system';

type NotifyInput = {
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Notifications are a side effect: a failure here must never undo the action that caused it.
  async toUser(userId: string, input: NotifyInput) {
    await this.create({ ...input, userId });
  }

  async toRoles(roles: UserRole[], input: NotifyInput) {
    for (const role of roles) await this.create({ ...input, role });
  }

  async toEveryone(input: NotifyInput) {
    await this.create(input);
  }

  async list(user: AuthenticatedUser, take = 30) {
    const where = this.visibleTo(user);
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          reads: { where: { userId: user.id }, select: { readAt: true } },
        },
      }),
      this.prisma.notification.count({
        where: { ...where, reads: { none: { userId: user.id } } },
      }),
    ]);
    return {
      unread,
      items: items.map(({ reads, ...item }) => ({
        ...item,
        read: reads.length > 0,
      })),
    };
  }

  async markRead(user: AuthenticatedUser, id: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, ...this.visibleTo(user) },
    });
    if (!notification) throw new NotFoundException('Notification not found.');
    await this.prisma.notificationRead.upsert({
      where: { notificationId_userId: { notificationId: id, userId: user.id } },
      create: { notificationId: id, userId: user.id },
      update: {},
    });
    return { success: true };
  }

  async markAllRead(user: AuthenticatedUser) {
    const unread = await this.prisma.notification.findMany({
      where: { ...this.visibleTo(user), reads: { none: { userId: user.id } } },
      select: { id: true },
    });
    if (unread.length)
      await this.prisma.notificationRead.createMany({
        data: unread.map((row) => ({
          notificationId: row.id,
          userId: user.id,
        })),
        skipDuplicates: true,
      });
    return { success: true, marked: unread.length };
  }

  private visibleTo(user: AuthenticatedUser): Prisma.NotificationWhereInput {
    // Personal notifications, those sent to the user's role, and system-wide announcements.
    return {
      OR: [
        { userId: user.id },
        { userId: null, role: user.role },
        { userId: null, role: null },
      ],
    };
  }

  private async create(
    data: NotifyInput & { userId?: string; role?: UserRole },
  ) {
    try {
      await this.prisma.notification.create({ data });
    } catch (error) {
      this.logger.warn(
        `Could not create notification "${data.title}": ${String(error)}`,
      );
    }
  }
}
