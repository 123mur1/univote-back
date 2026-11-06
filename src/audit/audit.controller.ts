import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../auth/public.decorator';
import { AuditService } from './audit.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('elections')
  @Public()
  elections(@Query('electionId') electionId?: string, @Query('take') take?: string) {
    return this.audit.electionLog(electionId, Math.min(500, Math.max(1, Number(take) || 100)));
  }

  @Get('activity')
  @Roles(UserRole.SYSTEM_ADMINISTRATOR)
  activity(@Query('take') take?: string) {
    return this.audit.activityLog(Math.min(500, Math.max(1, Number(take) || 100)));
  }
}
