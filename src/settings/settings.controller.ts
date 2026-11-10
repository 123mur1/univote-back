import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { SettingsService } from './settings.service';

@Controller('settings')
@Roles(UserRole.SYSTEM_ADMINISTRATOR)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // The settings every portal needs (idle timeouts, permissions, academic year), readable by
  // any signed-in user. Security-sensitive values stay in the administrator-only endpoint.
  @Roles(
    UserRole.STUDENT,
    UserRole.ELECTION_OFFICER,
    UserRole.DISPUTE_RESOLUTION_COMMITTEE,
    UserRole.SYSTEM_ADMINISTRATOR,
  )
  @Get('client')
  client() {
    return this.settings.client();
  }

  @Get()
  get() {
    return this.settings.get();
  }

  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.settings.update(user, body);
  }

  @Get('officer-permissions')
  permissions() {
    return this.settings.listPermissions();
  }

  @Put('officer-permissions')
  setPermission(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { permission?: unknown; enabled?: unknown },
  ) {
    return this.settings.setPermission(user, body.permission, body.enabled);
  }
}
