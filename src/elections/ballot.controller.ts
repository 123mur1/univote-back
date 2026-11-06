import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { BallotService } from './ballot.service';

@Controller('elections')
export class BallotController {
  constructor(private readonly ballots: BallotService) {}

  @Roles(UserRole.STUDENT)
  @Post(':id/ballots')
  cast(@CurrentUser() user: AuthenticatedUser, @Param('id') electionId: string, @Body() body: { encryptedPayload?: unknown }) {
    return this.ballots.cast(user, electionId, body.encryptedPayload);
  }

  @Public()
  @Get('receipts/:receipt')
  verify(@Param('receipt') receipt: string) {
    return this.ballots.verifyReceipt(receipt);
  }
}
