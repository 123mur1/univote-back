import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ElectionsController } from './elections.controller';
import { ElectionsService } from './elections.service';
import { BallotController } from './ballot.controller';
import { BallotService } from './ballot.service';
import { NominationsController } from './nominations.controller';
import { NominationsService } from './nominations.service';
import { VoterRollController } from './voter-roll.controller';
import { VoterRollService } from './voter-roll.service';

@Module({ imports: [AuditModule], controllers: [ElectionsController, BallotController, NominationsController, VoterRollController], providers: [ElectionsService, BallotService, NominationsService, VoterRollService] })
export class ElectionsModule {}
