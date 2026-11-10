import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { SearchService } from '../search/search.service';
import { StatsService } from './stats.service';

@Controller()
export class StatsController {
  constructor(
    private readonly stats: StatsService,
    private readonly searchService: SearchService,
  ) {}

  @Roles(UserRole.SYSTEM_ADMINISTRATOR)
  @Get('stats/admin')
  admin(@Query() query: { college?: string; campus?: string; days?: string }) {
    return this.stats.admin(query);
  }

  @Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
  @Get('stats/officer')
  officer(@CurrentUser() user: AuthenticatedUser) {
    return this.stats.officer(user);
  }

  @Roles(UserRole.STUDENT)
  @Get('stats/student')
  student(@CurrentUser() user: AuthenticatedUser) {
    return this.stats.student(user);
  }

  @Get('search')
  search(@CurrentUser() user: AuthenticatedUser, @Query('q') q?: string) {
    return this.searchService.search(user, q);
  }
}
