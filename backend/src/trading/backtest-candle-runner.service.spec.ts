import { BadRequestException } from '@nestjs/common';
import { BacktestCandleRunnerService } from './backtest-candle-runner.service';

describe('BacktestCandleRunnerService', () => {
  function createService() {
    const runs = {
      get: jest.fn(),
    };
    const execution = {
      start: jest.fn(),
      complete: jest.fn(),
      fail: jest.fn(),
    };
    const candles = {
      list: jest.fn(),
    };
    const simulator = {
      simulate: jest.fn(),
    };

    return {
      service: new BacktestCandleRunnerService(
        runs as any,
        execution as any,
        candles as any,
        simulator as any,
      ),
      runs,
      execution,
      candles,
      simulator,
    };
  }

  function createRun(overrides: Record<string, unknown> = {}) {
    return {
      id: 'run-1',
      exchange: 'BINANCE',
      symbol: 'BTCUSDT',
      interval: '5m',
      startTime: new Date('2026-08-01T00:00:00.000Z'),
      endTime: new Date('2026-08-02T00:00:00.000Z'),
      initialCapital: '1000',
      strategy: {
        maxDcaOrders: 3,
        dcaStepPercent: '5',
        dcaMultiplier: '1.5',
        takeProfitPercent: '1.5',
        independentFromLevel: 4,
        riskBudgetQuote: '1000',
        baseOrderQuote: '100',
        recoveryEnabled: true,
        recoveryMaxOrders: 5,
        recoveryStepPercents: [5, 8, 12, 18, 25],
        recoveryMultipliers: [1, 1.5, 2, 3, 5],
        recoveryTakeProfitPercent: '1.5',
      },
      ...overrides,
    };
  }

  function createCandles(count: number, startTime: Date) {
    return Array.from({ length: count }, (_, index) => ({
      openTime: new Date(startTime.getTime() + index * 60_000),
      close: '100',
    }));
  }

  it('starts, simulates with strategy DCA parameters, and completes the run', async () => {
    const { service, runs, execution, candles, simulator } = createService();
    const run = createRun();
    const historicalCandles = [
      { openTime: run.startTime, close: '100' },
      { openTime: new Date(run.startTime.getTime() + 60_000), close: '90' },
      { openTime: new Date(run.startTime.getTime() + 120_000), close: '110' },
    ];
    const result = {
      endingCapital: '1150.00000000',
      realizedPnlQuote: '150.00000000',
      returnPercent: '15.000000',
      maxDrawdownPercent: '5.000000',
      tradeCount: 3,
    };
    const completed = { ...run, status: 'COMPLETED', ...result };

    runs.get.mockResolvedValue(run);
    execution.start.mockResolvedValue({ ...run, status: 'RUNNING' });
    candles.list.mockResolvedValue(historicalCandles);
    simulator.simulate.mockReturnValue(result);
    execution.complete.mockResolvedValue(completed);

    await expect(service.run('user-1', 'run-1')).resolves.toEqual(completed);

    expect(runs.get).toHaveBeenCalledWith('user-1', 'run-1');
    expect(execution.start).toHaveBeenCalledWith('user-1', 'run-1');
    expect(candles.list).toHaveBeenCalledWith({
      exchange: 'BINANCE',
      symbol: 'BTCUSDT',
      interval: '5m',
      startTime: run.startTime,
      endTime: run.endTime,
      limit: 5000,
    });
    expect(simulator.simulate).toHaveBeenCalledWith({
      initialCapital: '1000',
      candles: historicalCandles,
      maxEntries: 4,
      priceDeviationPercent: '5',
      volumeMultiplier: '1.5',
      takeProfitPercent: '1.5',
      independentFromLevel: 4,
      riskBudgetQuote: '1000',
      baseOrderQuote: '100',
      recoveryEnabled: true,
      recoveryMaxOrders: 5,
      recoveryStepPercents: [5, 8, 12, 18, 25],
      recoveryMultipliers: [1, 1.5, 2, 3, 5],
      recoveryTakeProfitPercent: '1.5',
      continuousCycles: true,
    });
    expect(execution.complete).toHaveBeenCalledWith('run-1', result);
    expect(execution.fail).not.toHaveBeenCalled();
  });

  it('loads every full candle page without duplicating page boundaries', async () => {
    const { service, runs, execution, candles, simulator } = createService();
    const startTime = new Date('2026-01-01T00:00:00.000Z');
    const firstPage = createCandles(5000, startTime);
    const lastOpenTime = firstPage[firstPage.length - 1].openTime;
    const secondPage = createCandles(
      2,
      new Date(lastOpenTime.getTime() + 1),
    );
    const run = createRun({
      startTime,
      endTime: new Date(secondPage[1].openTime.getTime() + 60_000),
    });
    const result = {
      endingCapital: '1000.00000000',
      realizedPnlQuote: '0.00000000',
      returnPercent: '0.000000',
      maxDrawdownPercent: '0.000000',
      tradeCount: 1,
    };

    runs.get.mockResolvedValue(run);
    execution.start.mockResolvedValue({ ...run, status: 'RUNNING' });
    candles.list
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    simulator.simulate.mockReturnValue(result);
    execution.complete.mockResolvedValue({ id: run.id, status: 'COMPLETED' });

    await service.run('user-1', run.id);

    expect(candles.list).toHaveBeenNthCalledWith(1, {
      exchange: run.exchange,
      symbol: run.symbol,
      interval: run.interval,
      startTime,
      endTime: run.endTime,
      limit: 5000,
    });
    expect(candles.list).toHaveBeenNthCalledWith(2, {
      exchange: run.exchange,
      symbol: run.symbol,
      interval: run.interval,
      startTime: new Date(lastOpenTime.getTime() + 1),
      endTime: run.endTime,
      limit: 5000,
    });
    expect(candles.list).toHaveBeenCalledTimes(2);
    expect(simulator.simulate).toHaveBeenCalledWith({
      initialCapital: run.initialCapital,
      candles: [...firstPage, ...secondPage],
      maxEntries: 4,
      priceDeviationPercent: '5',
      volumeMultiplier: '1.5',
      takeProfitPercent: '1.5',
      independentFromLevel: 4,
      riskBudgetQuote: '1000',
      baseOrderQuote: '100',
      recoveryEnabled: true,
      recoveryMaxOrders: 5,
      recoveryStepPercents: [5, 8, 12, 18, 25],
      recoveryMultipliers: [1, 1.5, 2, 3, 5],
      recoveryTakeProfitPercent: '1.5',
      continuousCycles: true,
    });
  });

  it('stops pagination when a full page is followed by no candles', async () => {
    const { service, runs, execution, candles, simulator } = createService();
    const startTime = new Date('2026-01-01T00:00:00.000Z');
    const firstPage = createCandles(5000, startTime);
    const run = createRun({
      startTime,
      endTime: new Date('2026-12-31T00:00:00.000Z'),
    });
    const result = {
      endingCapital: '1000.00000000',
      realizedPnlQuote: '0.00000000',
      returnPercent: '0.000000',
      maxDrawdownPercent: '0.000000',
      tradeCount: 1,
    };

    runs.get.mockResolvedValue(run);
    execution.start.mockResolvedValue({ ...run, status: 'RUNNING' });
    candles.list.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([]);
    simulator.simulate.mockReturnValue(result);
    execution.complete.mockResolvedValue({ id: run.id, status: 'COMPLETED' });

    await service.run('user-1', run.id);

    expect(candles.list).toHaveBeenCalledTimes(2);
    expect(simulator.simulate).toHaveBeenCalledWith(
      expect.objectContaining({ candles: firstPage }),
    );
  });

  it('marks the run failed when no historical candles are available', async () => {
    const { service, runs, execution, candles, simulator } = createService();
    const run = createRun({
      symbol: 'ETHUSDT',
      interval: '1h',
    });

    runs.get.mockResolvedValue(run);
    execution.start.mockResolvedValue({ ...run, status: 'RUNNING' });
    candles.list.mockResolvedValue([]);
    execution.fail.mockResolvedValue({ id: 'run-1', status: 'FAILED' });

    await expect(service.run('user-1', 'run-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(simulator.simulate).not.toHaveBeenCalled();
    expect(execution.complete).not.toHaveBeenCalled();
    expect(execution.fail).toHaveBeenCalledWith(
      'run-1',
      expect.any(BadRequestException),
    );
  });

  it('marks the run failed when candle loading throws', async () => {
    const { service, runs, execution, candles, simulator } = createService();
    const run = createRun();
    const error = new Error('Database unavailable');

    runs.get.mockResolvedValue(run);
    execution.start.mockResolvedValue({ ...run, status: 'RUNNING' });
    candles.list.mockRejectedValue(error);
    execution.fail.mockResolvedValue({ id: 'run-1', status: 'FAILED' });

    await expect(service.run('user-1', 'run-1')).rejects.toBe(error);
    expect(simulator.simulate).not.toHaveBeenCalled();
    expect(execution.complete).not.toHaveBeenCalled();
    expect(execution.fail).toHaveBeenCalledWith('run-1', error);
  });

  it('marks the run failed when DCA simulation throws', async () => {
    const { service, runs, execution, candles, simulator } = createService();
    const run = createRun();
    const historicalCandles = [
      { openTime: run.startTime, close: '100' },
    ];
    const error = new Error('Simulation failed');

    runs.get.mockResolvedValue(run);
    execution.start.mockResolvedValue({ ...run, status: 'RUNNING' });
    candles.list.mockResolvedValue(historicalCandles);
    simulator.simulate.mockImplementation(() => {
      throw error;
    });
    execution.fail.mockResolvedValue({ id: 'run-1', status: 'FAILED' });

    await expect(service.run('user-1', 'run-1')).rejects.toBe(error);
    expect(simulator.simulate).toHaveBeenCalledWith({
      initialCapital: '1000',
      candles: historicalCandles,
      maxEntries: 4,
      priceDeviationPercent: '5',
      volumeMultiplier: '1.5',
      takeProfitPercent: '1.5',
      independentFromLevel: 4,
      riskBudgetQuote: '1000',
      baseOrderQuote: '100',
      recoveryEnabled: true,
      recoveryMaxOrders: 5,
      recoveryStepPercents: [5, 8, 12, 18, 25],
      recoveryMultipliers: [1, 1.5, 2, 3, 5],
      recoveryTakeProfitPercent: '1.5',
      continuousCycles: true,
    });
    expect(execution.complete).not.toHaveBeenCalled();
    expect(execution.fail).toHaveBeenCalledWith('run-1', error);
  });

  it('does not mark a run failed when lookup or start fails before candle loading', async () => {
    const { service, runs, execution, candles, simulator } = createService();
    const error = new Error('Pending run was not found');
    runs.get.mockRejectedValue(error);

    await expect(service.run('user-1', 'run-2')).rejects.toBe(error);
    expect(execution.start).not.toHaveBeenCalled();
    expect(candles.list).not.toHaveBeenCalled();
    expect(simulator.simulate).not.toHaveBeenCalled();
    expect(execution.complete).not.toHaveBeenCalled();
    expect(execution.fail).not.toHaveBeenCalled();
  });
});
