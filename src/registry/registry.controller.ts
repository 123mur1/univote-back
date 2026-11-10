import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RegistryService } from './registry.service';

@Controller('registry')
@Roles(UserRole.ELECTION_OFFICER, UserRole.SYSTEM_ADMINISTRATOR)
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query()
    query: {
      q?: string;
      campus?: string;
      college?: string;
      school?: string;
      enrolment?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    return this.registry.list(user, query);
  }

  @Get('facets')
  facets(@CurrentUser() user: AuthenticatedUser) {
    return this.registry.facets(user);
  }

  @Post('records')
  addRecord(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.registry.addRecord(user, body);
  }

  @Get(':registrationNumber')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('registrationNumber') registrationNumber: string,
  ) {
    return this.registry.get(user, registrationNumber);
  }

  @Post('import')
  import(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { mode: unknown; sourceFilename: unknown; students: unknown },
  ) {
    return this.registry.importRows(user, body);
  }
}
