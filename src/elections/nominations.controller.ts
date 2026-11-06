import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { NominationsService } from './nominations.service';

@Controller('nominations')
export class NominationsController {
  constructor(private readonly nominations: NominationsService) {}

  @Roles(UserRole.STUDENT)
  @Post()
  submit(@CurrentUser() user: AuthenticatedUser, @Body() body: Record<string, unknown>) {
    return this.nominations.submit(user, body);
  }

  @Roles(UserRole.STUDENT)
  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.nominations.mine(user);
  }

  @Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: string) {
    return this.nominations.list(user, status);
  }

  @Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
  @Patch(':id/decision')
  decide(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: { status?: unknown; note?: unknown }) {
    return this.nominations.decide(user, id, body);
  }

  @Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
  @Patch(':id/documents/:documentId')
  reviewDocument(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('documentId') documentId: string, @Body() body: { status?: unknown; note?: unknown }) {
    return this.nominations.reviewDocument(user, id, documentId, body);
  }
}
