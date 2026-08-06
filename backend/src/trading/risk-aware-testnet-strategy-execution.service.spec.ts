import { NotFoundException } from '@nestjs/common';
import { RiskAwareTestnetStrategyExecutionService } from './risk-aware-testnet-strategy-execution.service';
import { RecoveryStrategyService } from './recovery-strategy.service';
import { TestnetStrategyExecutionService } from './testnet-strategy-execution.service';

describe('RiskAwareTestnetStrategyExecutionService', () => {
  const userId = 'user-1';
  const strategy = {
    id: 'strategy-1',
    userId,
    mode: 'BINANCE_TESTNET',
    environment: 'TESTNET',
    paperTrading: false,
  };
  const openPosition = {
    id: 'position-1',
    strategyId: strategy.id,
    userId,
    status: 'OPEN',
    averageEntryPrice: 100,
  };

  const prisma = {
    tradingStrategy: { findFirst: jest.fn() },
    tradingPosition: { findFirst: jest.fn() },
  } as any;
  const testnetOrders = {} as any;
  const strategyActions = {} as any;
  const notifications = {} as any;
  const risk = { assertCanExecute: jest.fn() } as any;

  let service: RiskAwareTestnetStrategyExecutionService;
  let baseExecutionSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tradingStrategy.findFirst.mockResolvedValue(strategy);
    prisma.tradingPosition.findFirst.mockResolvedValue(openPosition);
    risk.assertCanExecute.mockResolvedValue(undefined);

    service = new RiskAwareTestnetStrategyExecutionService(
      prisma,
      testnetOrders,
      strategyActions,
      notifications,
      risk,
      new RecoveryStrategyService(),
    );

    baseExecutionSpy = jest
      .spyOn(TestnetStrategyExecutionService.prototype, 'executeMarketOrder')
      .mockResolvedValue({ submitted: true } as any);
  });

  afterEach(() => {
    baseExecutionSpy.mockRestore();
  });

  it('enforces mode and risk limits before delegating to exchange execution', async () => {
    const input = {
      strategyId: strategy.id,
      side: 'BUY' as const,
      quantity: 2,
      actionType: 'DCA_ENTRY' as const,
      triggerPrice: 95,
      allowRunningStrategy: true,
    };

    await expect(service.executeMarketOrder(userId, input)).resolves.toEqual({ submitted: true });

    expect(risk.assertCanExecute).toHaveBeenCalledWith(
      userId,
      strategy,
      openPosition,
      'DCA_ENTRY',
      190,
    );
    expect(baseExecutionSpy).toHaveBeenCalledWith(userId, input);
    expect(risk.assertCanExecute.mock.invocationCallOrder[0]).toBeLessThan(
      baseExecutionSpy.mock.invocationCallOrder[0],
    );
  });

  it('uses the open-position average when no trigger price is supplied', async () => {
    await service.executeMarketOrder(userId, {
      strategyId: strategy.id,
      side: 'SELL',
      quantity: 0.5,
      actionType: 'PARENT_EXIT',
    });

    expect(risk.assertCanExecute).toHaveBeenCalledWith(
      userId,
      strategy,
      openPosition,
      'PARENT_EXIT',
      50,
    );
  });

  it('does not delegate when the risk service rejects execution', async () => {
    risk.assertCanExecute.mockRejectedValue(new Error('risk limit reached'));

    await expect(
      service.executeMarketOrder(userId, {
        strategyId: strategy.id,
        side: 'BUY',
        quantity: 1,
        actionType: 'INDEPENDENT_ENTRY',
        triggerPrice: 90,
      }),
    ).rejects.toThrow('risk limit reached');

    expect(baseExecutionSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown strategy before risk or exchange execution', async () => {
    prisma.tradingStrategy.findFirst.mockResolvedValue(null);

    await expect(
      service.executeMarketOrder(userId, {
        strategyId: 'missing',
        side: 'BUY',
        quantity: 1,
        actionType: 'INITIAL_ENTRY',
        triggerPrice: 100,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(risk.assertCanExecute).not.toHaveBeenCalled();
    expect(baseExecutionSpy).not.toHaveBeenCalled();
  });
});
