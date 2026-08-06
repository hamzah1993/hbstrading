import { Injectable, Logger } from '@nestjs/common';
import { MarketDataService } from '../market/market-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisLockService, type RedisLock } from '../redis/redis-lock.service';
import { TestnetStrategyExecutionService } from './testnet-strategy-execution.service';
import { RecoveryStrategyService } from './recovery-strategy.service';

export type TestnetStrategyRunnerAction =
  | 'OPEN'
  | 'DCA'
  | 'INDEPENDENT_ENTRY'
  | 'INDEPENDENT_TAKE_PROFIT'
  | 'RECOVERY_DCA'
  | 'RECOVERY_TAKE_PROFIT'
  | 'TAKE_PROFIT'
  | 'HOLD'
  | 'SKIP'
  | 'ERROR';

export type TestnetStrategyRunnerResult = {
  strategyId: string;
  symbol: string;
  action: TestnetStrategyRunnerAction;
  price?: number;
  quantity?: number;
  positionId?: string;
  subPositionId?: string;
  message?: string;
};

const DEFAULT_TESTNET_STRATEGY_EXECUTION_LOCK_TTL_MS = 30_000;
const ACTIVE_ORDER_STATUSES = ['PENDING', 'PARTIALLY_FILLED'] as const;
const ACTIVE_ACTION_STATUSES = ['PENDING', 'SUBMITTED'] as const;

const getLockTtlMilliseconds = (): number => {
  const value = Number.parseInt(
    process.env.TESTNET_STRATEGY_EXECUTION_LOCK_TTL_MS ?? '',
    10,
  );
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TESTNET_STRATEGY_EXECUTION_LOCK_TTL_MS;
};

@Injectable()
export class TestnetStrategyRunnerService {
  private readonly logger = new Logger(TestnetStrategyRunnerService.name);
  private readonly runningStrategies = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly testnetExecution: TestnetStrategyExecutionService,
    private readonly redisLock: RedisLockService,
    private readonly recoveryStrategy: RecoveryStrategyService,
  ) {}

  async runUserStrategies(userId: string): Promise<TestnetStrategyRunnerResult[]> {
    const strategies = await this.prisma.tradingStrategy.findMany({
      where: {
        userId,
        status: 'RUNNING',
        paperTrading: false,
        environment: 'TESTNET',
      },
      include: {
        positions: {
          where: { status: 'OPEN' },
          orderBy: { openedAt: 'desc' },
          take: 1,
          include: {
            subPositions: {
              where: { status: 'OPEN' },
              orderBy: { level: 'asc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const results: TestnetStrategyRunnerResult[] = [];
    for (const strategy of strategies) {
      results.push(await this.runStrategy(userId, strategy));
    }
    return results;
  }

  private async hasPendingExecution(
    userId: string,
    strategyId: string,
  ): Promise<boolean> {
    const [activeOrder, activeAction] = await Promise.all([
      this.prisma.tradingOrder.findFirst({
        where: {
          userId,
          status: { in: [...ACTIVE_ORDER_STATUSES] },
          position: { strategyId },
        },
        select: { id: true },
      }),
      this.prisma.strategyAction.findFirst({
        where: {
          userId,
          strategyId,
          status: { in: [...ACTIVE_ACTION_STATUSES] },
        },
        select: { id: true },
      }),
    ]);

    return Boolean(activeOrder || activeAction);
  }

  private async runStrategy(userId: string, strategy: any): Promise<TestnetStrategyRunnerResult> {
    if (this.runningStrategies.has(strategy.id)) {
      return {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        action: 'SKIP',
        message: 'Strategy tick is already in progress',
      };
    }

    this.runningStrategies.add(strategy.id);
    let lock: RedisLock | null = null;

    try {
      lock = await this.redisLock.acquire(
        `hbs:lock:testnet-strategy:${strategy.id}`,
        getLockTtlMilliseconds(),
      );

      if (!lock) {
        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: 'SKIP',
          message: 'Strategy tick is already running on another instance',
        };
      }

      if (await this.hasPendingExecution(userId, strategy.id)) {
        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: 'SKIP',
          message: 'A Testnet order or strategy action is still pending',
        };
      }

      const quote = await this.marketData.getQuote(strategy.symbol, 'testnet');
      if (!Number.isFinite(quote.price) || quote.price <= 0) {
        throw new Error('Unable to calculate testnet quantity from the market price');
      }

      const openPosition = strategy.positions[0];
      if (!openPosition) {
        const baseOrderQuote = Number(strategy.baseOrderQuote);
        const riskBudgetQuote = Number(strategy.riskBudgetQuote);
        const quoteAmount = Math.min(baseOrderQuote, riskBudgetQuote);
        if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) {
          throw new Error('Initial testnet quote amount must be greater than zero');
        }

        const quantity = quoteAmount / quote.price;
        const actionKey = `strategy:${strategy.id}:initial-entry`;
        const execution = await this.testnetExecution.executeMarketOrder(userId, {
          strategyId: strategy.id,
          side: 'BUY',
          quantity,
          actionType: 'INITIAL_ENTRY',
          actionKey,
          level: 1,
          triggerPrice: quote.price,
          plannedQuoteAmount: quoteAmount,
          allowRunningStrategy: true,
        });

        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: execution.duplicate ? 'SKIP' : 'OPEN',
          price: quote.price,
          quantity,
          positionId: execution.savedOrder?.positionId,
          message: execution.duplicate ? 'Initial entry action was already claimed' : undefined,
        };
      }

      if (openPosition.recoveryMode) {
        const basket = this.recoveryStrategy.basketTotals(openPosition, openPosition.subPositions ?? []);
        const globalTakeProfit = Number(
          openPosition.recoveryTakeProfitPrice ?? this.recoveryStrategy.globalTakeProfit(strategy, basket) ?? 0,
        );
        if (globalTakeProfit > 0 && quote.price >= globalTakeProfit) {
          const independentToClose = [...(openPosition.subPositions ?? [])]
            .filter((item: any) => item.status === 'OPEN' && Number(item.quantity) > 0)
            .sort((a: any, b: any) => Number(b.level) - Number(a.level))[0];
          if (independentToClose) {
            const quantity = Number(independentToClose.quantity);
            const actionKey = `strategy:${strategy.id}:position:${openPosition.id}:recovery-independent-exit:${independentToClose.id}`;
            const execution = await this.testnetExecution.executeMarketOrder(userId, {
              strategyId: strategy.id,
              side: 'SELL',
              quantity,
              actionType: 'INDEPENDENT_EXIT',
              actionKey,
              level: Number(independentToClose.level),
              triggerPrice: globalTakeProfit,
              allowRunningStrategy: true,
            });
            return {
              strategyId: strategy.id,
              symbol: strategy.symbol,
              action: execution.duplicate ? 'SKIP' : 'RECOVERY_TAKE_PROFIT',
              price: quote.price,
              quantity,
              positionId: openPosition.id,
              subPositionId: independentToClose.id,
              message: execution.duplicate ? 'Recovery independent exit was already claimed' : undefined,
            };
          }

          const parentQuantity = Number(openPosition.totalQuantity);
          if (parentQuantity > 0) {
            const actionKey = `strategy:${strategy.id}:position:${openPosition.id}:recovery-parent-exit`;
            const execution = await this.testnetExecution.executeMarketOrder(userId, {
              strategyId: strategy.id,
              side: 'SELL',
              quantity: parentQuantity,
              actionType: 'PARENT_EXIT',
              actionKey,
              triggerPrice: globalTakeProfit,
              allowRunningStrategy: true,
            });
            return {
              strategyId: strategy.id,
              symbol: strategy.symbol,
              action: execution.duplicate ? 'SKIP' : 'RECOVERY_TAKE_PROFIT',
              price: quote.price,
              quantity: parentQuantity,
              positionId: openPosition.id,
              message: execution.duplicate ? 'Recovery parent exit was already claimed' : undefined,
            };
          }
        }

        const remainingBudget = Math.max(Number(strategy.riskBudgetQuote) - basket.costQuote, 0);
        const recoveryLeg = this.recoveryStrategy.nextLeg(strategy, {
          recoveryDcaCount: Number(openPosition.recoveryDcaCount),
          anchorPrice: Number(openPosition.recoveryAnchorPrice),
          baseOrderQuote: Number(strategy.baseOrderQuote),
          remainingRiskBudget: remainingBudget,
        });
        if (recoveryLeg && recoveryLeg.quoteAmount > 0 && quote.price <= recoveryLeg.triggerPrice) {
          const quantity = recoveryLeg.quoteAmount / quote.price;
          const actionKey = `strategy:${strategy.id}:position:${openPosition.id}:recovery-dca:${recoveryLeg.recoveryLevel}`;
          const execution = await this.testnetExecution.executeMarketOrder(userId, {
            strategyId: strategy.id,
            side: 'BUY',
            quantity,
            actionType: 'RECOVERY_DCA_ENTRY',
            actionKey,
            level: Number(strategy.maxDcaOrders) + recoveryLeg.recoveryLevel + 1,
            triggerPrice: recoveryLeg.triggerPrice,
            plannedQuoteAmount: recoveryLeg.quoteAmount,
            allowRunningStrategy: true,
          });
          return {
            strategyId: strategy.id,
            symbol: strategy.symbol,
            action: execution.duplicate ? 'SKIP' : 'RECOVERY_DCA',
            price: quote.price,
            quantity,
            positionId: openPosition.id,
            message: execution.duplicate ? 'Recovery DCA action was already claimed' : undefined,
          };
        }

        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: 'HOLD',
          price: quote.price,
          positionId: openPosition.id,
          message: recoveryLeg ? 'Recovery mode is waiting for the next DCA or global TP' : 'Recovery maximum or risk budget reached; waiting for global TP',
        };
      }

      const triggeredSubPosition = openPosition.subPositions?.find((subPosition: any) => {
        const quantity = Number(subPosition.quantity);
        const takeProfitPrice = Number(subPosition.takeProfitPrice);
        return (
          Number.isFinite(quantity) &&
          quantity > 0 &&
          Number.isFinite(takeProfitPrice) &&
          takeProfitPrice > 0 &&
          quote.price >= takeProfitPrice
        );
      });

      if (triggeredSubPosition) {
        const quantity = Number(triggeredSubPosition.quantity);
        const takeProfitPrice = Number(triggeredSubPosition.takeProfitPrice);
        const actionKey = `strategy:${strategy.id}:position:${openPosition.id}:subposition:${triggeredSubPosition.id}:independent-exit`;
        const execution = await this.testnetExecution.executeMarketOrder(userId, {
          strategyId: strategy.id,
          side: 'SELL',
          quantity,
          actionType: 'INDEPENDENT_EXIT',
          actionKey,
          level: Number(triggeredSubPosition.level),
          triggerPrice: takeProfitPrice,
          allowRunningStrategy: true,
        });

        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: execution.duplicate ? 'SKIP' : 'INDEPENDENT_TAKE_PROFIT',
          price: quote.price,
          quantity,
          positionId: openPosition.id,
          subPositionId: triggeredSubPosition.id,
          message: execution.duplicate ? 'Independent take-profit action was already claimed' : undefined,
        };
      }

      const totalQuantity = Number(openPosition.totalQuantity);
      const takeProfitPrice = Number(openPosition.takeProfitPrice ?? 0);
      if (
        Number.isFinite(totalQuantity) &&
        totalQuantity > 0 &&
        Number.isFinite(takeProfitPrice) &&
        takeProfitPrice > 0 &&
        quote.price >= takeProfitPrice
      ) {
        const actionKey = `strategy:${strategy.id}:position:${openPosition.id}:parent-exit`;
        const execution = await this.testnetExecution.executeMarketOrder(userId, {
          strategyId: strategy.id,
          side: 'SELL',
          quantity: totalQuantity,
          actionType: 'PARENT_EXIT',
          actionKey,
          level: Math.max(Number(openPosition.dcaCount) + 1, 1),
          triggerPrice: takeProfitPrice,
          allowRunningStrategy: true,
        });

        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: execution.duplicate ? 'SKIP' : 'TAKE_PROFIT',
          price: quote.price,
          quantity: totalQuantity,
          positionId: openPosition.id,
          message: execution.duplicate ? 'Take-profit action was already claimed' : undefined,
        };
      }

      const recoveryAnchor = openPosition.subPositions?.find(
        (item: any) => Number(item.level) === Number(strategy.independentFromLevel) && item.status === 'OPEN',
      );
      if (recoveryAnchor) {
        const basket = this.recoveryStrategy.basketTotals(openPosition, openPosition.subPositions);
        const recoveryLeg = this.recoveryStrategy.nextLeg(strategy, {
          recoveryDcaCount: 0,
          anchorPrice: Number(recoveryAnchor.entryPrice),
          baseOrderQuote: Number(strategy.baseOrderQuote),
          remainingRiskBudget: Math.max(Number(strategy.riskBudgetQuote) - basket.costQuote, 0),
        });
        if (recoveryLeg && recoveryLeg.quoteAmount > 0 && quote.price <= recoveryLeg.triggerPrice) {
          const quantity = recoveryLeg.quoteAmount / quote.price;
          const actionKey = `strategy:${strategy.id}:position:${openPosition.id}:recovery-dca:${recoveryLeg.recoveryLevel}`;
          const execution = await this.testnetExecution.executeMarketOrder(userId, {
            strategyId: strategy.id,
            side: 'BUY',
            quantity,
            actionType: 'RECOVERY_DCA_ENTRY',
            actionKey,
            level: Number(strategy.maxDcaOrders) + recoveryLeg.recoveryLevel + 1,
            triggerPrice: recoveryLeg.triggerPrice,
            plannedQuoteAmount: recoveryLeg.quoteAmount,
            allowRunningStrategy: true,
          });
          return {
            strategyId: strategy.id,
            symbol: strategy.symbol,
            action: execution.duplicate ? 'SKIP' : 'RECOVERY_DCA',
            price: quote.price,
            quantity,
            positionId: openPosition.id,
            message: execution.duplicate ? 'Recovery activation action was already claimed' : undefined,
          };
        }
      }

      const dcaCount = Number(openPosition.dcaCount);
      const maxDcaOrders = Number(strategy.maxDcaOrders);
      const nextLevel = dcaCount + 2;
      const nextDcaPrice = Number(openPosition.nextDcaPrice ?? 0);

      if (dcaCount >= maxDcaOrders) {
        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: 'HOLD',
          price: quote.price,
          positionId: openPosition.id,
          message: 'Maximum DCA orders reached',
        };
      }

      if (!Number.isFinite(nextDcaPrice) || nextDcaPrice <= 0 || quote.price > nextDcaPrice) {
        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: 'HOLD',
          price: quote.price,
          positionId: openPosition.id,
          message: 'No testnet exit or DCA trigger has been reached',
        };
      }

      const multiplier = Number(strategy.dcaMultiplier);
      const baseOrderQuote = Number(strategy.baseOrderQuote);
      const requestedQuote = baseOrderQuote * Math.pow(multiplier, dcaCount + 1);
      const totalExposure = this.recoveryStrategy.basketTotals(
        openPosition,
        openPosition.subPositions ?? [],
      ).costQuote;
      const remainingBudget = Math.max(Number(strategy.riskBudgetQuote) - totalExposure, 0);
      const quoteAmount = Math.min(requestedQuote, remainingBudget);

      if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) {
        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: 'HOLD',
          price: quote.price,
          positionId: openPosition.id,
          message: 'No remaining risk budget is available for DCA',
        };
      }

      const quantity = quoteAmount / quote.price;
      const independentFromLevel = Number(strategy.independentFromLevel);
      const independent = nextLevel >= independentFromLevel;
      const actionType = independent ? 'INDEPENDENT_ENTRY' : 'DCA_ENTRY';
      const actionKey = independent
        ? `strategy:${strategy.id}:position:${openPosition.id}:independent-entry:${nextLevel}`
        : `strategy:${strategy.id}:position:${openPosition.id}:dca:${nextLevel}`;

      const execution = await this.testnetExecution.executeMarketOrder(userId, {
        strategyId: strategy.id,
        side: 'BUY',
        quantity,
        actionType,
        actionKey,
        level: nextLevel,
        triggerPrice: nextDcaPrice,
        plannedQuoteAmount: quoteAmount,
        allowRunningStrategy: true,
      });

      return {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        action: execution.duplicate ? 'SKIP' : independent ? 'INDEPENDENT_ENTRY' : 'DCA',
        price: quote.price,
        quantity,
        positionId: openPosition.id,
        message: execution.duplicate
          ? independent
            ? 'Independent entry action was already claimed'
            : 'DCA action was already claimed'
          : undefined,
      };
    } catch (error) {
      return {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        action: 'ERROR',
        message: error instanceof Error ? error.message : 'Testnet strategy tick failed',
      };
    } finally {
      if (lock) {
        try {
          await this.redisLock.release(lock);
        } catch (error) {
          this.logger.warn(
            `Failed to release the Testnet strategy lock for ${strategy.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      this.runningStrategies.delete(strategy.id);
    }
  }
}
