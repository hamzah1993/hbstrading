import { BadRequestException, Injectable } from '@nestjs/common';
import { BacktestDcaSimulatorService } from './backtest-dca-simulator.service';
import { BacktestExecutionService } from './backtest-execution.service';
import { BacktestRunService } from './backtest-run.service';
import { HistoricalCandleQueryService } from './historical-candle-query.service';

const BACKTEST_CANDLE_PAGE_SIZE = 5000;

@Injectable()
export class BacktestCandleRunnerService {
  constructor(
    private readonly runs: BacktestRunService,
    private readonly execution: BacktestExecutionService,
    private readonly candles: HistoricalCandleQueryService,
    private readonly simulator: BacktestDcaSimulatorService,
  ) {}

  async run(userId: string, runId: string) {
    const run = await this.runs.get(userId, runId);
    await this.execution.start(userId, run.id);

    try {
      const candles = [];
      let startTime = run.startTime;

      while (startTime <= run.endTime) {
        const page = await this.candles.list({
          exchange: run.exchange,
          symbol: run.symbol,
          interval: run.interval,
          startTime,
          endTime: run.endTime,
          limit: BACKTEST_CANDLE_PAGE_SIZE,
        });

        if (page.length === 0) break;
        candles.push(...page);

        if (page.length < BACKTEST_CANDLE_PAGE_SIZE) break;

        const lastOpenTime = page[page.length - 1].openTime;
        startTime = new Date(lastOpenTime.getTime() + 1);
      }

      if (candles.length === 0) {
        throw new BadRequestException(
          'No historical candles were found for the requested backtest range',
        );
      }

      const result = this.simulator.simulate({
        initialCapital: run.initialCapital,
        candles,
        maxEntries: run.strategy.maxDcaOrders + 1,
        priceDeviationPercent: run.strategy.dcaStepPercent,
        volumeMultiplier: run.strategy.dcaMultiplier,
        takeProfitPercent: run.strategy.takeProfitPercent,
        independentFromLevel: run.strategy.independentFromLevel,
        riskBudgetQuote: run.strategy.riskBudgetQuote,
        baseOrderQuote: run.strategy.baseOrderQuote,
        recoveryEnabled: run.strategy.recoveryEnabled,
        recoveryMaxOrders: run.strategy.recoveryMaxOrders,
        recoveryStepPercents: run.strategy.recoveryStepPercents as number[],
        recoveryMultipliers: run.strategy.recoveryMultipliers as number[],
        recoveryTakeProfitPercent: run.strategy.recoveryTakeProfitPercent,
        continuousCycles: true,
      });

      return this.execution.complete(run.id, result);
    } catch (error) {
      await this.execution.fail(run.id, error);
      throw error;
    }
  }
}
