import { BadRequestException, Injectable } from '@nestjs/common';

export type RecoveryConfig = {
  recoveryEnabled?: boolean;
  recoveryMaxOrders?: number;
  recoveryStepPercents?: unknown;
  recoveryMultipliers?: unknown;
  recoveryTakeProfitPercent?: unknown;
};

export type RecoveryLeg = {
  recoveryLevel: number;
  dropPercent: number;
  multiplier: number;
  triggerPrice: number;
  requestedQuote: number;
  quoteAmount: number;
};

export type BasketTotals = {
  quantity: number;
  costQuote: number;
  averageEntryPrice: number;
};

const DEFAULT_STEPS = [5, 8, 12, 18, 25];
const DEFAULT_MULTIPLIERS = [1, 1.5, 2, 3, 5];

@Injectable()
export class RecoveryStrategyService {
  normalizeConfig(strategy: RecoveryConfig) {
    const enabled = strategy.recoveryEnabled !== false;
    const maxOrders = Number(strategy.recoveryMaxOrders ?? 5);
    const steps = this.numberArray(strategy.recoveryStepPercents, DEFAULT_STEPS);
    const multipliers = this.numberArray(strategy.recoveryMultipliers, DEFAULT_MULTIPLIERS);
    const takeProfitPercent = Number(strategy.recoveryTakeProfitPercent ?? 1.5);

    if (!Number.isInteger(maxOrders) || maxOrders < 0 || maxOrders > 20) {
      throw new BadRequestException('Recovery maximum orders must be between 0 and 20');
    }
    if (maxOrders > steps.length || maxOrders > multipliers.length) {
      throw new BadRequestException('Recovery steps and multipliers must cover every recovery order');
    }
    if (steps.some((value, index) => value <= 0 || (index > 0 && value <= steps[index - 1]))) {
      throw new BadRequestException('Recovery step percentages must be positive and strictly increasing');
    }
    if (multipliers.some((value) => value <= 0)) {
      throw new BadRequestException('Recovery multipliers must be positive');
    }
    if (!Number.isFinite(takeProfitPercent) || takeProfitPercent <= 0) {
      throw new BadRequestException('Recovery take-profit percent must be positive');
    }

    return { enabled, maxOrders, steps, multipliers, takeProfitPercent };
  }

  shouldActivate(strategy: RecoveryConfig, campaignLevel: number, independentFromLevel: number) {
    const config = this.normalizeConfig(strategy);
    return config.enabled && config.maxOrders > 0 && campaignLevel >= independentFromLevel;
  }

  nextLeg(
    strategy: RecoveryConfig,
    input: {
      recoveryDcaCount: number;
      anchorPrice: number;
      baseOrderQuote: number;
      remainingRiskBudget: number;
    },
  ): RecoveryLeg | null {
    const config = this.normalizeConfig(strategy);
    const index = Math.max(0, Math.trunc(input.recoveryDcaCount));
    if (!config.enabled || index >= config.maxOrders || input.remainingRiskBudget <= 0) return null;
    if (!Number.isFinite(input.anchorPrice) || input.anchorPrice <= 0) {
      throw new BadRequestException('Recovery anchor price must be positive');
    }
    if (!Number.isFinite(input.baseOrderQuote) || input.baseOrderQuote <= 0) {
      throw new BadRequestException('Base order must be positive');
    }

    const requestedQuote = input.baseOrderQuote * config.multipliers[index];
    return {
      recoveryLevel: index + 1,
      dropPercent: config.steps[index],
      multiplier: config.multipliers[index],
      triggerPrice: input.anchorPrice * (1 - config.steps[index] / 100),
      requestedQuote,
      quoteAmount: Math.min(requestedQuote, input.remainingRiskBudget),
    };
  }

  basketTotals(parent: { totalQuantity: unknown; totalCostQuote: unknown }, subPositions: Array<{ status?: string; quantity: unknown; costQuote: unknown }>): BasketTotals {
    let quantity = Number(parent.totalQuantity ?? 0);
    let costQuote = Number(parent.totalCostQuote ?? 0);
    for (const subPosition of subPositions) {
      if (subPosition.status && subPosition.status !== 'OPEN') continue;
      quantity += Number(subPosition.quantity ?? 0);
      costQuote += Number(subPosition.costQuote ?? 0);
    }
    return {
      quantity,
      costQuote,
      averageEntryPrice: quantity > 0 ? costQuote / quantity : 0,
    };
  }

  globalTakeProfit(strategy: RecoveryConfig, basket: BasketTotals) {
    if (basket.averageEntryPrice <= 0) return null;
    const { takeProfitPercent } = this.normalizeConfig(strategy);
    return basket.averageEntryPrice * (1 + takeProfitPercent / 100);
  }

  private numberArray(value: unknown, fallback: number[]) {
    const source = Array.isArray(value) ? value : fallback;
    const numbers = source.map(Number);
    if (!numbers.length || numbers.some((number) => !Number.isFinite(number))) {
      throw new BadRequestException('Recovery configuration must contain valid numeric values');
    }
    return numbers;
  }
}
