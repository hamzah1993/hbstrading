import { Injectable, NotFoundException } from '@nestjs/common';
import { BinanceTestnetOrderService } from '../exchange/binance/binance-testnet-order.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ExecuteTestnetStrategyInput,
  TestnetStrategyExecutionService,
} from './testnet-strategy-execution.service';
import { TestnetStrategyActionService } from './testnet-strategy-action.service';
import { TestnetStrategyRiskService } from './testnet-strategy-risk.service';
import { RecoveryStrategyService } from './recovery-strategy.service';

/**
 * Runtime enforcement wrapper for every Binance Testnet order path.
 *
 * The base execution service remains responsible for exchange submission,
 * reconciliation, and fill accounting. This wrapper performs mode and risk
 * validation immediately before delegating to that implementation, so manual,
 * automatic, and retry-driven executions share the same safety boundary.
 */
@Injectable()
export class RiskAwareTestnetStrategyExecutionService extends TestnetStrategyExecutionService {
  constructor(
    private readonly riskPrisma: PrismaService,
    testnetOrders: BinanceTestnetOrderService,
    strategyActions: TestnetStrategyActionService,
    notifications: NotificationsService,
    private readonly risk: TestnetStrategyRiskService,
    recoveryStrategy: RecoveryStrategyService,
  ) {
    super(riskPrisma, testnetOrders, strategyActions, notifications, recoveryStrategy);
  }

  override async executeMarketOrder(userId: string, input: ExecuteTestnetStrategyInput) {
    const strategy = await this.riskPrisma.tradingStrategy.findFirst({
      where: { id: input.strategyId, userId },
    });
    if (!strategy) throw new NotFoundException('Strategy not found');

    const openPosition = await this.riskPrisma.tradingPosition.findFirst({
      where: { strategyId: strategy.id, userId, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });

    const estimatedPrice = Number(
      input.triggerPrice ?? openPosition?.averageEntryPrice ?? 0,
    );
    const plannedQuoteAmount = Number(input.plannedQuoteAmount ?? 0);
    const estimatedOrderQuote = Number.isFinite(plannedQuoteAmount) && plannedQuoteAmount > 0
      ? plannedQuoteAmount
      : Number.isFinite(estimatedPrice) && estimatedPrice > 0
        ? input.quantity * estimatedPrice
        : 0;

    await this.risk.assertCanExecute(
      userId,
      strategy,
      openPosition,
      input.actionType,
      estimatedOrderQuote,
    );

    return super.executeMarketOrder(userId, input);
  }
}
