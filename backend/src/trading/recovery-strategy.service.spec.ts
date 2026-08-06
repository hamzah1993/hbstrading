import { BadRequestException } from '@nestjs/common';
import { RecoveryStrategyService } from './recovery-strategy.service';

describe('RecoveryStrategyService', () => {
  const service = new RecoveryStrategyService();
  const strategy = {
    recoveryEnabled: true,
    recoveryMaxOrders: 5,
    recoveryStepPercents: [5, 8, 12, 18, 25],
    recoveryMultipliers: [1, 1.5, 2, 3, 5],
    recoveryTakeProfitPercent: 1.5,
  };

  it('builds the next recovery order from the independent anchor price', () => {
    expect(service.nextLeg(strategy, {
      recoveryDcaCount: 1,
      anchorPrice: 80,
      baseOrderQuote: 100,
      remainingRiskBudget: 120,
    })).toEqual({
      recoveryLevel: 2,
      dropPercent: 8,
      multiplier: 1.5,
      triggerPrice: 73.60000000000001,
      requestedQuote: 150,
      quoteAmount: 120,
    });
  });

  it('hard caps a recovery order at the remaining fixed risk budget', () => {
    const leg = service.nextLeg(strategy, {
      recoveryDcaCount: 4,
      anchorPrice: 100,
      baseOrderQuote: 100,
      remainingRiskBudget: 75,
    });
    expect(leg?.requestedQuote).toBe(500);
    expect(leg?.quoteAmount).toBe(75);
  });

  it('calculates the weighted basket average across parent and open independent legs', () => {
    const basket = service.basketTotals(
      { totalQuantity: 2, totalCostQuote: 200 },
      [
        { status: 'OPEN', quantity: 1, costQuote: 80 },
        { status: 'CLOSED', quantity: 1, costQuote: 50 },
      ],
    );
    expect(basket).toEqual({ quantity: 3, costQuote: 280, averageEntryPrice: 280 / 3 });
    expect(service.globalTakeProfit(strategy, basket)).toBeCloseTo((280 / 3) * 1.015, 10);
  });

  it('rejects recovery arrays that cannot cover the configured maximum', () => {
    expect(() => service.normalizeConfig({
      ...strategy,
      recoveryMaxOrders: 3,
      recoveryStepPercents: [5, 8],
    })).toThrow(BadRequestException);
  });
});
