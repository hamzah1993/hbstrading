import { PaperTradingService } from './paper-trading.service';
import { RecoveryStrategyService } from './recovery-strategy.service';
import { RiskBudgetService } from './risk-budget.service';

describe('PaperTradingService recovery mode', () => {
  const strategy = {
    id: 'strategy-1',
    paperTrading: true,
    riskBudgetQuote: 1000,
    baseOrderQuote: 100,
    maxDcaOrders: 5,
    dcaStepPercent: 2,
    dcaMultiplier: 1.5,
    takeProfitPercent: 1.5,
    independentFromLevel: 5,
    recoveryEnabled: true,
    recoveryMaxOrders: 5,
    recoveryStepPercents: [5, 8, 12, 18, 25],
    recoveryMultipliers: [1, 1.5, 2, 3, 5],
    recoveryTakeProfitPercent: 1.5,
  };

  function createHarness(position: any) {
    const updated: any[] = [];
    const tx = {
      tradingOrder: { create: jest.fn(async ({ data }: any) => data) },
      tradingSubPosition: {
        create: jest.fn(async ({ data }: any) => ({ id: 'sub-created', status: 'OPEN', ...data })),
        update: jest.fn(async ({ data }: any) => data),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      tradingPosition: {
        update: jest.fn(async ({ data }: any) => {
          updated.push(data);
          return { ...position, ...data };
        }),
        findUnique: jest.fn(async () => ({ ...position, ...(updated.at(-1) ?? {}) })),
      },
    };
    const prisma = {
      tradingPosition: { findFirst: jest.fn().mockResolvedValue(position) },
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;
    const service = new PaperTradingService(
      prisma,
      new RiskBudgetService(),
      new RecoveryStrategyService(),
    );
    return { service, prisma, tx, updated };
  }

  it('activates recovery below the first independent entry and recalculates a global TP', async () => {
    const position = {
      id: 'position-1',
      userId: 'user-1',
      status: 'OPEN',
      totalQuantity: 3,
      totalCostQuote: 300,
      averageEntryPrice: 100,
      dcaCount: 4,
      recoveryMode: false,
      recoveryDcaCount: 0,
      takeProfitPrice: 101.5,
      nextDcaPrice: 78,
      strategy,
      orders: [{ averageFillPrice: 100 }],
      subPositions: [{
        id: 'sub-5', level: 5, status: 'OPEN', quantity: 1, costQuote: 80,
        entryPrice: 80, takeProfitPrice: 81.2,
      }],
      realizedPnlQuote: 0,
    };
    const { service, tx } = createHarness(position);

    const result = await service.processPrice('user-1', position.id, 75);

    expect(result.action).toBe('RECOVERY_DCA');
    expect(tx.tradingPosition.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        recoveryMode: true,
        recoveryDcaCount: 1,
        recoveryAnchorPrice: 80,
        totalCostQuote: 400,
        takeProfitPrice: null,
      }),
    }));
    const update = tx.tradingPosition.update.mock.calls[0][0].data;
    expect(update.recoveryTakeProfitPrice).toBeCloseTo(((400 + 80) / (3 + 100 / 75 + 1)) * 1.015, 10);
  });

  it('closes the complete paper basket at the recovery global TP', async () => {
    const position = {
      id: 'position-1',
      userId: 'user-1',
      status: 'OPEN',
      totalQuantity: 4,
      totalCostQuote: 380,
      averageEntryPrice: 95,
      dcaCount: 4,
      recoveryMode: true,
      recoveryDcaCount: 1,
      recoveryAnchorPrice: 80,
      recoveryTakeProfitPrice: 93,
      takeProfitPrice: null,
      nextDcaPrice: 73.6,
      strategy,
      orders: [],
      subPositions: [{
        id: 'sub-5', level: 5, status: 'OPEN', quantity: 1, costQuote: 80,
        entryPrice: 80, takeProfitPrice: 81.2,
      }],
      realizedPnlQuote: 0,
    };
    const { service, tx } = createHarness(position);

    const result = await service.processPrice('user-1', position.id, 94);

    expect(result.action).toBe('RECOVERY_TAKE_PROFIT');
    expect(tx.tradingOrder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ side: 'SELL', quantity: 5, quoteAmount: 470 }),
    }));
    expect(tx.tradingSubPosition.updateMany).toHaveBeenCalled();
    expect(tx.tradingPosition.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'CLOSED',
        totalQuantity: 0,
        totalCostQuote: 0,
        recoveryMode: false,
        realizedPnlQuote: 10,
      }),
    }));
  });
});
