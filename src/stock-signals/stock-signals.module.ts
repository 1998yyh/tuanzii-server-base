import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockSignalScanRun } from './entities/scan-run.entity';
import { StockSignal } from './entities/stock-signal.entity';
import { StockWatchlist } from './entities/watchlist.entity';
import { StockSignalsController } from './stock-signals.controller';
import { StockSignalsService } from './stock-signals.service';
import { SinaScannerService } from './sina-scanner.service';
import { WatchlistController } from './watchlist.controller';
import { WatchlistService } from './watchlist.service';
import { WatchlistCronService } from './watchlist-cron.service';
import { StockSectorsController } from './stock-sectors.controller';
import { StockSectorsService } from './stock-sectors.service';
import { StockPerformanceController } from './stock-performance.controller';
import { StockPerformanceService } from './stock-performance.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockSignalScanRun, StockSignal, StockWatchlist])],
  controllers: [
    StockSignalsController,
    WatchlistController,
    StockSectorsController,
    StockPerformanceController,
  ],
  providers: [
    StockSignalsService,
    SinaScannerService,
    WatchlistService,
    WatchlistCronService,
    StockSectorsService,
    StockPerformanceService,
  ],
})
export class StockSignalsModule {}
