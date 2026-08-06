import { TestnetStrategyRunnerService } from './testnet-strategy-runner.service';
import { RecoveryStrategyService } from './recovery-strategy.service';

describe('TestnetStrategyRunnerService', () => {
  const userId = 'user-1';

  const baseStrategy = {
    id: 'strategy-1',
    symbol: 'BTCUSDT',
    baseOrderQuote: 100,
    riskBudgetQuote: 1000,
    maxDcaOrders: 4,
    dcaMultiplier: 2,
    independentFromLevel: 4,
    recoveryEnabled: true,
    recoveryMaxOrders: 5,
    recoveryStepPercents: [5, 8, 12, 18, 25],
    recoveryMultipliers: [1, 1.5, 2, 3, 5],
    recoveryTakeProfitPercent: 1.5,
    positions: [],
  };

  function createService(
    strategies: any[],
    price: number,
    executionResult: any = {},
    lockAcquired = true,
    pendingOrder: any = null,
    pendingAction: any = null,
  ) {
    const prisma = {
      tradingStrategy: {
        findMany: jest.fn().mockResolvedValue(strategies),
      },
      tradingOrder: {
        findFirst: jest.fn().mockResolvedValue(pendingOrder),
      },
      strategyAction: {
        findFirst: jest.fn().mockResolvedValue(pendingAction),
      },
    } as any;
    const marketData = {
      getQuote: jest.fn().mockResolvedValue({ price }),
    } as any;
    const testnetExecution = {
      executeMarketOrder: jest.fn().mockResolvedValue({
        duplicate: false,
        savedOrder: { positionId: 'position-1' },
        ...executionResult,
      }),
    } as any;
    const redisLock = {
      acquire: jest
        .fn()
        .mockResolvedValue(lockAcquired ? { key: 'strategy-lock', token: 'token' } : null),
      release: jest.fn().mockResolvedValue(true),
    } as any;

    return {
      service: new TestnetStrategyRunnerService(
        prisma,
        marketData,
        testnetExecution,
        redisLock,
        new RecoveryStrategyService(),
      ),
      prisma,
      marketData,
      testnetExecution,
      redisLock,
    };
  }

  it('opens an initial Testnet position with a stable action key', async () => {
    const { service, testnetExecution, redisLock } = createService([baseStrategy], 50);

    const result = await service.runUserStrategies(userId);

    expect(result[0]).toMatchObject({ action: 'OPEN', quantity: 2, positionId: 'position-1' });
    expect(testnetExecution.executeMarketOrder).toHaveBeenCalledWith(userId, {
      strategyId: 'strategy-1',
      side: 'BUY',
      quantity: 2,
      actionType: 'INITIAL_ENTRY',
      actionKey: 'strategy:strategy-1:initial-entry',
      level: 1,
      triggerPrice: 50,
      plannedQuoteAmount: 100,
      allowRunningStrategy: true,
    });
    expect(redisLock.release).toHaveBeenCalledTimes(1);
  });

  it('submits a parent DCA before the independent level', async () => {
    const strategy = {
      ...baseStrategy,
      positions: [{
        id: 'position-1',
        totalQuantity: 2,
        totalCostQuote: 100,
        dcaCount: 1,
        nextDcaPrice: 45,
        takeProfitPrice: 60,
        subPositions: [],
      }],
    };
    const { service, testnetExecution } = createService([strategy], 40);

    const result = await service.runUserStrategies(userId);

    expect(result[0].action).toBe('DCA');
    expect(testnetExecution.executeMarketOrder).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ actionType: 'DCA_ENTRY', level: 3, quantity: 10 }),
    );
  });

  it('switches to an independent entry at the configured level', async () => {
    const strategy = {
      ...baseStrategy,
      positions: [{
        id: 'position-1',
        totalQuantity: 4,
        totalCostQuote: 300,
        dcaCount: 2,
        nextDcaPrice: 45,
        takeProfitPrice: 80,
        subPositions: [],
      }],
    };
    const { service, testnetExecution } = createService([strategy], 40);

    const result = await service.runUserStrategies(userId);

    expect(result[0].action).toBe('INDEPENDENT_ENTRY');
    expect(testnetExecution.executeMarketOrder).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        actionType: 'INDEPENDENT_ENTRY',
        level: 4,
        actionKey: 'strategy:strategy-1:position:position-1:independent-entry:4',
      }),
    );
  });

  it('prioritizes an independent take-profit exit', async () => {
    const strategy = {
      ...baseStrategy,
      positions: [{
        id: 'position-1',
        totalQuantity: 2,
        totalCostQuote: 100,
        dcaCount: 2,
        nextDcaPrice: 45,
        takeProfitPrice: 60,
        subPositions: [{
          id: 'sub-1',
          level: 4,
          quantity: 3,
          takeProfitPrice: 55,
        }],
      }],
    };
    const { service, testnetExecution } = createService([strategy], 56);

    const result = await service.runUserStrategies(userId);

    expect(result[0]).toMatchObject({
      action: 'INDEPENDENT_TAKE_PROFIT',
      subPositionId: 'sub-1',
      quantity: 3,
    });
    expect(testnetExecution.executeMarketOrder).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        side: 'SELL',
        actionType: 'INDEPENDENT_EXIT',
        level: 4,
      }),
    );
  });

  it('activates recovery DCA when price falls 5% below the first independent entry', async () => {
    const strategy = {
      ...baseStrategy,
      positions: [{
        id: 'position-1',
        totalQuantity: 3,
        totalCostQuote: 300,
        dcaCount: 3,
        recoveryMode: false,
        recoveryDcaCount: 0,
        nextDcaPrice: 78,
        takeProfitPrice: 110,
        subPositions: [{
          id: 'sub-4', level: 4, status: 'OPEN', quantity: 1, costQuote: 80,
          entryPrice: 80, takeProfitPrice: 81.2,
        }],
      }],
    };
    const { service, testnetExecution } = createService([strategy], 75);

    const result = await service.runUserStrategies(userId);

    expect(result[0].action).toBe('RECOVERY_DCA');
    expect(testnetExecution.executeMarketOrder).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        actionType: 'RECOVERY_DCA_ENTRY',
        actionKey: 'strategy:strategy-1:position:position-1:recovery-dca:1',
        triggerPrice: 76,
      }),
    );
  });

  it('uses the global recovery TP and closes independent legs in reverse order first', async () => {
    const strategy = {
      ...baseStrategy,
      positions: [{
        id: 'position-1',
        totalQuantity: 4,
        totalCostQuote: 380,
        dcaCount: 3,
        recoveryMode: true,
        recoveryDcaCount: 1,
        recoveryAnchorPrice: 80,
        recoveryTakeProfitPrice: 90,
        nextDcaPrice: 73.6,
        takeProfitPrice: null,
        subPositions: [
          { id: 'sub-4', level: 4, status: 'OPEN', quantity: 1, costQuote: 80, entryPrice: 80, takeProfitPrice: 81.2 },
          { id: 'sub-5', level: 5, status: 'OPEN', quantity: 0.5, costQuote: 35, entryPrice: 70, takeProfitPrice: 71.05 },
        ],
      }],
    };
    const { service, testnetExecution } = createService([strategy], 91);

    const result = await service.runUserStrategies(userId);

    expect(result[0]).toMatchObject({ action: 'RECOVERY_TAKE_PROFIT', subPositionId: 'sub-5' });
    expect(testnetExecution.executeMarketOrder).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        side: 'SELL',
        actionType: 'INDEPENDENT_EXIT',
        level: 5,
        triggerPrice: 90,
      }),
    );
  });

  it('submits the parent take-profit when no independent exit is triggered', async () => {
    const strategy = {
      ...baseStrategy,
      positions: [{
        id: 'position-1',
        totalQuantity: 2,
        totalCostQuote: 100,
        dcaCount: 1,
        nextDcaPrice: 45,
        takeProfitPrice: 55,
        subPositions: [],
      }],
    };
    const { service, testnetExecution } = createService([strategy], 56);

    const result = await service.runUserStrategies(userId);

    expect(result[0].action).toBe('TAKE_PROFIT');
    expect(testnetExecution.executeMarketOrder).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ side: 'SELL', actionType: 'PARENT_EXIT', quantity: 2 }),
    );
  });

  it('returns SKIP when the idempotent execution already exists', async () => {
    const { service } = createService([baseStrategy], 50, { duplicate: true });

    const result = await service.runUserStrategies(userId);

    expect(result[0]).toMatchObject({
      action: 'SKIP',
      message: 'Initial entry action was already claimed',
    });
  });

  it('holds when no trigger has been reached', async () => {
    const strategy = {
      ...baseStrategy,
      positions: [{
        id: 'position-1',
        totalQuantity: 2,
        totalCostQuote: 100,
        dcaCount: 1,
        nextDcaPrice: 45,
        takeProfitPrice: 60,
        subPositions: [],
      }],
    };
    const { service, testnetExecution } = createService([strategy], 50);

    const result = await service.runUserStrategies(userId);

    expect(result[0].action).toBe('HOLD');
    expect(testnetExecution.executeMarketOrder).not.toHaveBeenCalled();
  });

  it('returns ERROR when the exchange execution fails', async () => {
    const { service, testnetExecution, redisLock } = createService([baseStrategy], 50);
    testnetExecution.executeMarketOrder.mockRejectedValue(new Error('Binance unavailable'));

    const result = await service.runUserStrategies(userId);

    expect(result[0]).toMatchObject({ action: 'ERROR', message: 'Binance unavailable' });
    expect(redisLock.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pending order', { id: 'order-1' }, null],
    ['pending strategy action', null, { id: 'action-1' }],
  ])('skips execution when a %s exists', async (_label, pendingOrder, pendingAction) => {
    const { service, marketData, testnetExecution, redisLock } = createService(
      [baseStrategy],
      50,
      {},
      true,
      pendingOrder,
      pendingAction,
    );

    const result = await service.runUserStrategies(userId);

    expect(result[0]).toMatchObject({
      action: 'SKIP',
      message: 'A Testnet order or strategy action is still pending',
    });
    expect(marketData.getQuote).not.toHaveBeenCalled();
    expect(testnetExecution.executeMarketOrder).not.toHaveBeenCalled();
    expect(redisLock.release).toHaveBeenCalledTimes(1);
  });

  it('skips execution when another instance owns the strategy lock', async () => {
    const { service, marketData, testnetExecution, redisLock } = createService(
      [baseStrategy],
      50,
      {},
      false,
    );

    const result = await service.runUserStrategies(userId);

    expect(result[0]).toMatchObject({
      action: 'SKIP',
      message: 'Strategy tick is already running on another instance',
    });
    expect(marketData.getQuote).not.toHaveBeenCalled();
    expect(testnetExecution.executeMarketOrder).not.toHaveBeenCalled();
    expect(redisLock.release).not.toHaveBeenCalled();
  });
});
