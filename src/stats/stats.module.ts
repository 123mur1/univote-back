import { Module } from '@nestjs/common';
import { ElectionsModule } from '../elections/elections.module';
import { SearchService } from '../search/search.service';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  imports: [ElectionsModule],
  controllers: [StatsController],
  providers: [StatsService, SearchService],
})
export class StatsModule {}
