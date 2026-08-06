import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  BacktestRunStatus,
  BacktestTradeType,
  ExchangeName,
  Prisma,
} from '@prisma/client';
import { BacktestRunService } from './backtest-run.service';

describe('BacktestRunService', () => {
  function createService() {
    const tradingStrategy = {
      findFirst: jest.fn(),
    };
    const backtestRun = {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    };
    const prisma = { tradingStrategy, backtestRun } as any;

    return {
      service: new BacktestRunService(prisma),
      tradingStrategy,
      backtestRun,
    };
  }

  function createReportRun(overrides: Record<string, unknown> = {}) {
    return {
      id: 'run-1',
      initialCapital: new Prisma.Decimal(1000),
      strategy: {
        name: 'Strategy A',
        maxDcaOrders: 3,
        dcaStepPercent: new Prisma.Decimal(5),
        dcaMultiplier: new Prisma.Decimal(1.5),
        takeProfitPercent: new Prisma.Decimal(2),
        independentFromLevel: 3,
      },
      trades: [
        {
          id: 'trade-1',
          runId: 'run-1',
          type: BacktestTradeType.PARENT_ENTRY,
          level: 1,
          independent: false,
          executedAt: new Date('2026-08-01T00:00:00.000Z'),
          price: new Prisma.Decimal(100),
          quantity: new Prisma.Decimal(5),
          quoteAmount: new Prisma.Decimal(500),
          feeQuote: new Prisma.Decimal(1),
          realizedPnlQuote: null,
        },
        {
          id: 'trade-2',
          runId: 'run-1',
          type: BacktestTradeType.PARENT_EXIT,
          level: 2,
          independent: false,
          executedAt: new Date('2026-08-01T01:00:00.000Z'),
          price: new Prisma.Decimal(110),
          quantity: new Prisma.Decimal(5),
          quoteAmount: new Prisma.Decimal(550),
          feeQuote: new Prisma.Decimal(1.1),
          realizedPnlQuote: new Prisma.Decimal(48.9),
        },
        {
          id: 'trade-3',
          runId: 'run-1',
          type: BacktestTradeType.INDEPENDENT_EXIT,
          level: 3,
          independent: true,
          executedAt: new Date('2026-08-01T02:00:00.000Z'),
          price: new Prisma.Decimal(90),
          quantity: new Prisma.Decimal(1),
          quoteAmount: new Prisma.Decimal(90),
          feeQuote: new Prisma.Decimal(0.18),
          realizedPnlQuote: new Prisma.Decimal(-10.18),
        },
      ],
      equityPoints: [
        {
          id: 'point-1',
          runId: 'run-1',
          recordedAt: new Date('2026-08-01T00:00:00.000Z'),
          equityQuote: new Prisma.Decimal(1000),
          drawdownPercent: new Prisma.Decimal(0),
        },
        {
          id: 'point-2',
          runId: 'run-1',
          recordedAt: new Date('2026-08-01T01:00:00.000Z'),
          equityQuote: new Prisma.Decimal(1050),
          drawdownPercent: new Prisma.Decimal(0),
        },
      ],
      ...overrides,
    };
  }

  it('creates a normalized pending run for a user-owned strategy', async () => {
    const { service, tradingStrategy, backtestRun } = createService();
    const startTime = new Date('2026-08-01T00:00:00.000Z');
    const endTime = new Date('2026-08-02T00:00:00.000Z');
    tradingStrategy.findFirst.mockResolvedValue({
      id: 'strategy-1',
      symbol: 'BTCUSDT',
      exchange: ExchangeName.BINANCE,
    });
    backtestRun.create.mockResolvedValue({ id: 'run-1' });

    await expect(
      service.create('user-1', {
        strategyId: ' strategy-1 ',
        symbol: ' btcusdt ',
        interval: ' 5m ',
        startTime,
        endTime,
        initialCapital: '1000.50',
      }),
    ).resolves.toEqual({ id: 'run-1' });

    expect(tradingStrategy.findFirst).toHaveBeenCalledWith({
      where: { id: 'strategy-1', userId: 'user-1' },
      select: { id: true, symbol: true, exchange: true },
    });
    expect(backtestRun.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        strategyId: 'strategy-1',
        exchange: ExchangeName.BINANCE,
        symbol: 'BTCUSDT',
        interval: '5m',
        startTime,
        endTime,
        initialCapital: new Prisma.Decimal('1000.50'),
        status: BacktestRunStatus.PENDING,
      },
    });
  });

  it('rejects creation when the strategy does not belong to the user', async () => {
    const { service, tradingStrategy, backtestRun } = createService();
    tradingStrategy.findFirst.mockResolvedValue(null);

    await expect(
      service.create('user-1', {
        strategyId: 'strategy-2',
        symbol: 'BTCUSDT',
        interval: '5m',
        startTime: new Date('2026-08-01T00:00:00.000Z'),
        endTime: new Date('2026-08-02T00:00:00.000Z'),
        initialCapital: 1000,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(backtestRun.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ strategyId: ' ', symbol: 'BTCUSDT', interval: '5m' }, 'Strategy ID is required'],
    [{ strategyId: 'strategy-1', symbol: ' ', interval: '5m' }, 'Symbol is required'],
    [{ strategyId: 'strategy-1', symbol: 'BTCUSDT', interval: ' ' }, 'Interval is required'],
  ])('rejects missing required creation fields %#', async (partial, message) => {
    const { service, tradingStrategy, backtestRun } = createService();

    await expect(
      service.create('user-1', {
        strategyId: partial.strategyId,
        symbol: partial.symbol,
        interval: partial.interval,
        startTime: new Date('2026-08-01T00:00:00.000Z'),
        endTime: new Date('2026-08-02T00:00:00.000Z'),
        initialCapital: 1000,
      }),
    ).rejects.toThrow(message);

    expect(tradingStrategy.findFirst).not.toHaveBeenCalled();
    expect(backtestRun.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      startTime: new Date('invalid'),
      endTime: new Date('2026-08-02T00:00:00.000Z'),
      initialCapital: 1000,
    },
    {
      startTime: new Date('2026-08-01T00:00:00.000Z'),
      endTime: new Date('invalid'),
      initialCapital: 1000,
    },
    {
      startTime: new Date('2026-08-02T00:00:00.000Z'),
      endTime: new Date('2026-08-01T00:00:00.000Z'),
      initialCapital: 1000,
    },
    {
      startTime: new Date('2026-08-01T00:00:00.000Z'),
      endTime: new Date('2026-08-02T00:00:00.000Z'),
      initialCapital: 0,
    },
  ])('rejects invalid creation inputs %#', async (invalid) => {
    const { service, tradingStrategy, backtestRun } = createService();

    await expect(
      service.create('user-1', {
        strategyId: 'strategy-1',
        symbol: 'BTCUSDT',
        interval: '5m',
        ...invalid,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tradingStrategy.findFirst).not.toHaveBeenCalled();
    expect(backtestRun.create).not.toHaveBeenCalled();
  });

  it('lists user runs with descending creation order and a bounded limit', async () => {
    const { service, backtestRun } = createService();
    backtestRun.findMany.mockResolvedValue([{ id: 'run-1' }]);

    await expect(service.list('user-1', 50)).resolves.toEqual([{ id: 'run-1' }]);
    expect(backtestRun.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it.each([0, -1, 501, 1.5])('rejects an invalid run list limit: %s', (limit) => {
    const { service, backtestRun } = createService();

    expect(() => service.list('user-1', limit)).toThrow(BadRequestException);
    expect(backtestRun.findMany).not.toHaveBeenCalled();
  });

  it('returns a user-owned run and rejects missing runs', async () => {
    const { service, backtestRun } = createService();
    backtestRun.findFirst
      .mockResolvedValueOnce({ id: 'run-1' })
      .mockResolvedValueOnce(null);

    await expect(service.get('user-1', ' run-1 ')).resolves.toEqual({ id: 'run-1' });
    expect(backtestRun.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: 'run-1', userId: 'user-1' },
      include: {
        strategy: {
          select: {
            maxDcaOrders: true,
            dcaStepPercent: true,
            dcaMultiplier: true,
            takeProfitPercent: true,
            independentFromLevel: true,
            riskBudgetQuote: true,
            baseOrderQuote: true,
            recoveryEnabled: true,
            recoveryMaxOrders: true,
            recoveryStepPercents: true,
            recoveryMultipliers: true,
            recoveryTakeProfitPercent: true,
          },
        },
      },
    });

    await expect(service.get('user-1', 'run-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('calculates analytics for wins, losses, peak equity, and DCA levels', async () => {
    const { service, backtestRun } = createService();
    backtestRun.findFirst.mockResolvedValue(createReportRun());

    const result = await service.report('user-1', 'run-1');

    expect(result.analytics).toEqual({
      completedExitCount: 2,
      winningTradeCount: 1,
      losingTradeCount: 1,
      winRatePercent: '50.000000',
      grossProfitQuote: '48.90000000',
      grossLossQuote: '10.18000000',
      averageWinQuote: '48.90000000',
      averageLossQuote: '10.18000000',
      profitFactor: '4.803536',
      peakEquityQuote: '1050.00000000',
      maximumDcaLevelUsed: 3,
      independentEntries: 0,
      independentExits: 1,
    });
  });

  it('compares user-owned runs in requested order and rejects missing runs', async () => {
    const { service, backtestRun } = createService();
    const first = createReportRun({ id: 'run-1' });
    const second = createReportRun({
      id: 'run-2',
      strategy: { ...createReportRun().strategy, name: 'Strategy B' },
    });
    backtestRun.findMany.mockResolvedValueOnce([second, first]).mockResolvedValueOnce([first]);

    const compared = await service.compare('user-1', ['run-1', 'run-2']);
    expect(compared.map((item) => item.run.id)).toEqual(['run-1', 'run-2']);

    await expect(service.compare('user-1', ['run-1', 'run-2'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each([
    [[]],
    [['run-1']],
    [Array.from({ length: 11 }, (_, index) => `run-${index + 1}`)],
  ])('rejects invalid comparison selections: %j', async (runIds) => {
    const { service, backtestRun } = createService();

    await expect(service.compare('user-1', runIds)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(backtestRun.findMany).not.toHaveBeenCalled();
  });

  it('exports deterministic trade and equity CSV data', async () => {
    const { service, backtestRun } = createService();
    backtestRun.findFirst.mockResolvedValue(createReportRun());

    const trades = await service.exportTradesCsv('user-1', 'run-1');
    const equity = await service.exportEquityCsv('user-1', 'run-1');

    expect(trades).toContain(
      '"executedAt","type","level","independent","price","quantity","quoteAmount","feeQuote","realizedPnlQuote"',
    );
    expect(trades).toContain(
      '"2026-08-01T01:00:00.000Z","PARENT_EXIT","2","false","110","5","550","1.1","48.9"',
    );
    expect(equity).toContain(
      '"recordedAt","equityQuote","drawdownPercent"',
    );
    expect(equity).toContain(
      '"2026-08-01T01:00:00.000Z","1050","0"',
    );
  });

  it('rejects an empty run ID before querying Prisma', async () => {
    const { service, backtestRun } = createService();

    await expect(service.get('user-1', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(backtestRun.findFirst).not.toHaveBeenCalled();
  });
});
