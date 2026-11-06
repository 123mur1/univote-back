import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { UsersService } from './users.service';

@Controller('users')
@Roles(UserRole.SYSTEM_ADMINISTRATOR)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('students')
  students(@Query() query: { q?: string; page?: string; pageSize?: string }) {
    return this.users.listStudents(query);
  }

  @Post('students')
  createStudent(@CurrentUser() admin: AuthenticatedUser, @Body() body: { registrationNumber?: unknown; phone?: unknown; password?: unknown }) {
    return this.users.createStudent(admin, body);
  }

  @Post('staff')
  createStaff(@CurrentUser() admin: AuthenticatedUser, @Body() body: { name?: unknown; email?: unknown; password?: unknown; role?: unknown }) {
    return this.users.createStaff(admin, body);
  }

  @Patch(':id/credentials')
  credentials(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() body: { email?: unknown; password?: unknown }) {
    return this.users.updateCredentials(admin, id, body);
  }

  @Patch(':id/status')
  status(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() body: { active?: unknown }) {
    return this.users.setActive(admin, id, body.active);
  }

  @Post(':id/unlock')
  unlock(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.users.unlock(admin, id);
  }
}
