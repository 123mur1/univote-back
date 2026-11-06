import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { ElectionsModule } from './elections/elections.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { RegistryModule } from './registry/registry.module';
import { SettingsModule } from './settings/settings.module';
import { AuditModule } from './audit/audit.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule, RegistryModule, ElectionsModule, SettingsModule, UsersModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
