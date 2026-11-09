import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { ElectionsService } from './elections.service';

@Controller('elections')
export class ElectionsController {
  constructor(private readonly elections: ElectionsService) {}

  @Public()
  @Get()
  list() {
    return this.elections.list();
  }

  @Public()
  @Get(':id')
  get(@Param('id') id: string) {
    return this.elections.get(id);
  }

  @Roles(
    UserRole.ELECTION_OFFICER,
    UserRole.DISPUTE_RESOLUTION_COMMITTEE,
    UserRole.SYSTEM_ADMINISTRATOR,
  )
  @Get(':id/encrypted-ballots')
  encryptedBallots(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.elections.encryptedBallots(user, id);
  }

  @Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
  @Get(':id/turnout')
  turnout(@Param('id') id: string) {
    return this.elections.turnout(id);
  }

  @Public()
  @Get(':id/published-ballots')
  publishedBallots(@Param('id') id: string) {
    return this.elections.publishedBallots(id);
  }

  @Public()
  @Get(':id/results')
  results(@Param('id') id: string) {
    return this.elections.results(id);
  }

  @Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.elections.create(user, body);
  }

  @Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { status?: unknown },
  ) {
    return this.elections.updateStatus(user, id, body.status);
  }

  @Roles(
    UserRole.ELECTION_OFFICER,
    UserRole.DISPUTE_RESOLUTION_COMMITTEE,
    UserRole.SYSTEM_ADMINISTRATOR,
  )
  @Post(':id/publish')
  publishResults(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body()
    body: { resultHash?: unknown; bulletinRoot?: unknown; results?: unknown },
  ) {
    return this.elections.publishResults(user, id, body);
  }
}
