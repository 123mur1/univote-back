import { Controller, Get, Param, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { VoterRollService } from './voter-roll.service';

@Controller('elections')
@Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
export class VoterRollController {
  constructor(private readonly voterRoll: VoterRollService) {}

  @Get(':id/voters')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') electionId: string,
    @Query()
    query: {
      q?: string;
      school?: string;
      voted?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    return this.voterRoll.list(user, electionId, query);
  }
}
