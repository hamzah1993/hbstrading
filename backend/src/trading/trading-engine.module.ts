import { Module } from '@nestjs/common';
import { BinanceModule } from '../exchange/binance/binance.module';
import { MarketDataModule } from '../market/market-data.module';
import { BacktestBuyHoldSimulatorService } from './backtest-buy-hold-simulator.service';
import { BacktestCandleRunnerService } from './backtest-candle-runner.service';
import { BacktestDcaSimulatorService } from './backtest-dca-simulator.service';
import { BacktestExecutionService } from './backtest-execution.service';
import { BacktestRunController } from './backtest-run.controller';
import { BacktestRunService } from './backtest-run.service';
import { BinanceHistoricalCandleImporterService } from './binance-historical-candle-importer.service';
import { HistoricalCandleController } from './historical-candle.controller';
import { HistoricalCandleIngestionService } from './historical-candle-ingestion.service';
import { HistoricalCandleQueryService } from './historical-candle-query.service';
import { PaperStrategyRunnerService } from './paper-strategy-runner.service';
import { PaperStrategySchedulerService } from './paper-strategy-scheduler.service';
import { PaperTradingController } from './paper-trading.controller';
import { PaperTradingService } from './paper-trading.service';
import { RiskAwareTestnetStrategyExecutionService } from './risk-aware-testnet-strategy-execution.service';
import { RiskBudgetService } from './risk-budget.service';
import { RecoveryStrategyService } from './recovery-strategy.service';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';
import { TestnetActionRetrySchedulerService } from './testnet-action-retry-scheduler.service';
import { TestnetActionTimelineService } from './testnet-action-timeline.service';
import { TestnetEmergencyStopService } from './testnet-emergency-stop.service';
import { TestnetFillAccountingService } from './testnet-fill-accounting.service';
import { TestnetOrderSyncSchedulerService } from './testnet-order-sync-scheduler.service';
import { TestnetRunnerHealthService } from './testnet-runner-health.service';
import { TestnetStrategyActionService } from './testnet-strategy-action.service';
import { TestnetStrategyExecutionService } from './testnet-strategy-execution.service';
import { TestnetStrategyRiskService } from './testnet-strategy-risk.service';
import { TestnetStrategyRunnerService } from './testnet-strategy-runner.service';
import { TestnetStrategySchedulerService } from './testnet-strategy-scheduler.service';
import { TradingEngineController } from './trading-engine.controller';
import { TradingEngineService } from './trading-engine.service';

@Module({
  imports: [MarketDataModule, BinanceModule],
  controllers: [
    TradingEngineController,
    PaperTradingController,
    StrategyController,
    HistoricalCandleController,
    BacktestRunController,
  ],
  providers: [
    RiskBudgetService,
    RecoveryStrategyService,
    TradingEngineService,
    PaperTradingService,
    StrategyService,
    HistoricalCandleIngestionService,
    HistoricalCandleQueryService,
    BinanceHistoricalCandleImporterService,
    BacktestRunService,
    BacktestExecutionService,
    BacktestCandleRunnerService,
    BacktestBuyHoldSimulatorService,
    BacktestDcaSimulatorService,
    PaperStrategyRunnerService,
    PaperStrategySchedulerService,
    TestnetFillAccountingService,
    TestnetStrategyRiskService,
    RiskAwareTestnetStrategyExecutionService,
    {
      provide: TestnetStrategyExecutionService,
      useExisting: RiskAwareTestnetStrategyExecutionService,
    },
    TestnetRunnerHealthService,
    TestnetOrderSyncSchedulerService,
    TestnetStrategyActionService,
    TestnetActionRetrySchedulerService,
    TestnetActionTimelineService,
    TestnetEmergencyStopService,
    TestnetStrategyRunnerService,
    TestnetStrategySchedulerService,
  ],
  exports: [
    RiskBudgetService,
    RecoveryStrategyService,
    TradingEngineService,
    PaperTradingService,
    StrategyService,
    HistoricalCandleIngestionService,
    HistoricalCandleQueryService,
    BinanceHistoricalCandleImporterService,
    BacktestRunService,
    BacktestExecutionService,
    BacktestCandleRunnerService,
    BacktestBuyHoldSimulatorService,
    BacktestDcaSimulatorService,
    PaperStrategyRunnerService,
    TestnetFillAccountingService,
    TestnetStrategyRiskService,
    TestnetStrategyExecutionService,
    TestnetStrategyActionService,
    TestnetActionTimelineService,
    TestnetEmergencyStopService,
    TestnetStrategyRunnerService,
    TestnetRunnerHealthService,
  ],
})
export class TradingEngineModule {}
