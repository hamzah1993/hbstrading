import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BinanceTestnetOrderService } from '../exchange/binance/binance-testnet-order.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TestnetStrategyActionService } from './testnet-strategy-action.service';
import { RecoveryStrategyService } from './recovery-strategy.service';

export type ExecuteTestnetStrategyInput = {
  strategyId: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  actionType?: 'INITIAL_ENTRY' | 'DCA_ENTRY' | 'INDEPENDENT_ENTRY' | 'RECOVERY_DCA_ENTRY' | 'PARENT_EXIT' | 'INDEPENDENT_EXIT';
  actionKey?: string;
  level?: number | null;
  triggerPrice?: number | null;
  plannedQuoteAmount?: number | null;
  allowRunningStrategy?: boolean;
};

type BinanceOrderFill = {
  price?: string;
  qty?: string;
};

type BinanceOrderResponse = {
  orderId?: number | string;
  clientOrderId?: string;
  status?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  price?: string;
  fills?: BinanceOrderFill[];
};

type FillAccountingContext = {
  order: any;
  position: any;
  subPosition: any | null;
  strategy: any;
  deltaQuantity: number;
  deltaQuote: number;
  averageFillPrice: number;
};

@Injectable()
export class TestnetStrategyExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly testnetOrders: BinanceTestnetOrderService,
    private readonly strategyActions: TestnetStrategyActionService,
    private readonly notifications: NotificationsService,
    private readonly recoveryStrategy: RecoveryStrategyService,
  ) {}

  async closePosition(userId: string, positionId: string, subPositionId?: string) {
    const position = await this.prisma.tradingPosition.findFirst({
      where: { id: positionId, userId },
      include: {
        strategy: true,
        subPositions: true,
        orders: {
          where: { status: { in: ['PENDING', 'PARTIALLY_FILLED'] } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!position) throw new NotFoundException('Testnet position not found');
    if (position.strategy.paperTrading || position.strategy.environment !== 'TESTNET') {
      throw new BadRequestException('Only Binance Testnet positions can be closed here');
    }
    if (position.status !== 'OPEN') {
      throw new BadRequestException('Only open Testnet positions can be closed');
    }
    if (position.strategy.status !== 'PAUSED') {
      throw new BadRequestException('Pause the bot before closing a Testnet position');
    }
    if (position.orders.length > 0) {
      throw new BadRequestException('Sync or finish pending Testnet orders before closing this position');
    }

    if (subPositionId) {
      const subPosition = position.subPositions.find((item) => item.id === subPositionId);
      if (!subPosition || subPosition.status !== 'OPEN') {
        throw new BadRequestException('Open independent sub-position was not found');
      }
      const quantity = Number(subPosition.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException('Independent sub-position quantity is invalid');
      }
      return this.executeMarketOrder(userId, {
        strategyId: position.strategyId,
        side: 'SELL',
        quantity,
        actionType: 'INDEPENDENT_EXIT',
        actionKey: `manual-independent-close:${subPosition.id}:${subPosition.openedAt.toISOString()}`,
        level: subPosition.level,
      });
    }

    const quantity = Number(position.totalQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Parent position quantity is invalid');
    }

    return this.executeMarketOrder(userId, {
      strategyId: position.strategyId,
      side: 'SELL',
      quantity,
      actionType: 'PARENT_EXIT',
      actionKey: `manual-parent-close:${position.id}:${position.updatedAt.toISOString()}`,
    });
  }

  async executeMarketOrder(userId: string, input: ExecuteTestnetStrategyInput) {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive number');
    }

    const strategy = await this.prisma.tradingStrategy.findFirst({
      where: { id: input.strategyId, userId },
    });
    if (!strategy) throw new NotFoundException('Strategy not found');
    if (strategy.paperTrading) {
      throw new BadRequestException('Paper strategies cannot place Binance testnet orders');
    }
    if (strategy.environment !== 'TESTNET') {
      throw new BadRequestException('Only Binance testnet strategy execution is allowed');
    }

    const isAutomaticRunningExecution = input.allowRunningStrategy === true && strategy.status === 'RUNNING';
    if (strategy.status !== 'PAUSED' && !isAutomaticRunningExecution) {
      throw new BadRequestException(
        'Strategy must be PAUSED for a controlled testnet order or RUNNING for an authorized automatic execution',
      );
    }

    const openPosition = await this.prisma.tradingPosition.findFirst({
      where: { strategyId: strategy.id, userId, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });

    const actionKey = input.actionKey?.trim();
    const actionType = input.actionType;
    let independentSubPosition: Awaited<ReturnType<typeof this.prisma.tradingSubPosition.findUnique>> = null;

    if (actionType === 'INDEPENDENT_EXIT') {
      if (!openPosition) throw new BadRequestException('No open testnet position is available');
      const level = input.level ?? null;
      if (!level) throw new BadRequestException('Independent exit level is required');
      independentSubPosition = await this.prisma.tradingSubPosition.findUnique({
        where: { positionId_level: { positionId: openPosition.id, level } },
      });
      if (!independentSubPosition || independentSubPosition.status !== 'OPEN') {
        throw new BadRequestException('Open independent sub-position was not found');
      }
      if (input.quantity > Number(independentSubPosition.quantity)) {
        throw new BadRequestException('Sell quantity exceeds the independent sub-position quantity');
      }
    } else if (input.side === 'SELL') {
      if (!openPosition) throw new BadRequestException('No open testnet position is available to sell');
      if (input.quantity > Number(openPosition.totalQuantity)) {
        throw new BadRequestException('Sell quantity exceeds the open testnet position quantity');
      }
    }

    let claimedActionId: string | null = null;

    if (actionKey || actionType) {
      if (!actionKey || !actionType) {
        throw new BadRequestException('Both actionKey and actionType are required for idempotent execution');
      }

      const claim = await this.strategyActions.claim(userId, {
        strategyId: strategy.id,
        positionId: openPosition?.id ?? null,
        type: actionType,
        side: input.side,
        quantity: input.quantity,
        level: input.level ?? null,
        triggerPrice: input.triggerPrice ?? null,
        idempotencyKey: actionKey,
      });

      if (!claim.claimed) {
        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          environment: strategy.environment,
          paperTrading: strategy.paperTrading,
          duplicate: true,
          action: claim.action,
        };
      }

      claimedActionId = claim.action.id;
    }

    const clientOrderId = `hbs-testnet-${randomUUID()}`;

    try {
      const exchangeOrder = (await this.testnetOrders.placeMarketOrder(userId, {
        symbol: strategy.symbol,
        side: input.side,
        quantity: input.quantity,
        clientOrderId,
      })) as BinanceOrderResponse;

      const executedQuantity = Number(exchangeOrder.executedQty ?? 0);
      const quoteAmount = Number(exchangeOrder.cummulativeQuoteQty ?? 0);
      const averageFillPrice = this.calculateAverageFillPrice(exchangeOrder, executedQuantity, quoteAmount);
      const status = this.mapOrderStatus(exchangeOrder.status);

      const savedOrder = await this.prisma.$transaction(async (tx) => {
        let position = openPosition;
        let subPositionId: string | null = independentSubPosition?.id ?? null;
        const independentEntry = actionType === 'INDEPENDENT_ENTRY' && input.side === 'BUY';
        const recoveryEntry = actionType === 'RECOVERY_DCA_ENTRY' && input.side === 'BUY';
        const independentExit = actionType === 'INDEPENDENT_EXIT' && input.side === 'SELL';

        if (!position && input.side === 'BUY') {
          const parentTriggers = this.calculateParentTriggers(strategy, executedQuantity, quoteAmount, averageFillPrice, 0);
          position = await tx.tradingPosition.create({
            data: {
              userId,
              strategyId: strategy.id,
              symbol: strategy.symbol,
              status: 'OPEN',
              totalQuantity: independentEntry ? 0 : executedQuantity,
              totalCostQuote: independentEntry ? 0 : quoteAmount,
              averageEntryPrice: independentEntry ? 0 : averageFillPrice,
              realizedPnlQuote: 0,
              dcaCount: 0,
              nextDcaPrice: independentEntry ? null : parentTriggers.nextDcaPrice,
              takeProfitPrice: independentEntry ? null : parentTriggers.takeProfitPrice,
            },
          });
        } else if (position && input.side === 'BUY' && !independentEntry && executedQuantity > 0) {
          const previousQuantity = Number(position.totalQuantity);
          const previousCost = Number(position.totalCostQuote);
          const totalQuantity = previousQuantity + executedQuantity;
          const totalCostQuote = previousCost + quoteAmount;
          const averageEntryPrice = totalQuantity > 0 ? totalCostQuote / totalQuantity : 0;
          const dcaCount = recoveryEntry ? Number(position.dcaCount) : Number(position.dcaCount) + 1;
          const recoveryDcaCount = recoveryEntry ? Number(position.recoveryDcaCount) + 1 : Number(position.recoveryDcaCount);
          const parentTriggers = this.calculateParentTriggers(strategy, totalQuantity, totalCostQuote, averageEntryPrice, dcaCount);

          let recoveryData: Record<string, unknown> = {};
          if (recoveryEntry) {
            const subPositions = await tx.tradingSubPosition.findMany({
              where: { positionId: position.id, status: 'OPEN' },
              orderBy: { level: 'asc' },
            });
            const anchor = subPositions.find((item: any) => Number(item.level) === Number(strategy.independentFromLevel));
            const anchorPrice = Number(position.recoveryAnchorPrice ?? anchor?.entryPrice ?? 0);
            const basket = this.recoveryStrategy.basketTotals({ totalQuantity, totalCostQuote }, subPositions);
            const recoveryTakeProfitPrice = this.recoveryStrategy.globalTakeProfit(strategy, basket);
            const nextLeg = this.recoveryStrategy.nextLeg(strategy, {
              recoveryDcaCount,
              anchorPrice,
              baseOrderQuote: Number(strategy.baseOrderQuote),
              remainingRiskBudget: Math.max(Number(strategy.riskBudgetQuote) - basket.costQuote, 0),
            });
            recoveryData = {
              recoveryMode: true,
              recoveryDcaCount,
              recoveryAnchorPrice: anchorPrice,
              recoveryTakeProfitPrice,
              nextDcaPrice: nextLeg?.triggerPrice ?? null,
              takeProfitPrice: null,
            };
          }

          position = await tx.tradingPosition.update({
            where: { id: position.id },
            data: {
              totalQuantity,
              totalCostQuote,
              averageEntryPrice,
              dcaCount,
              nextDcaPrice: recoveryEntry ? undefined : parentTriggers.nextDcaPrice,
              takeProfitPrice: recoveryEntry ? undefined : parentTriggers.takeProfitPrice,
              ...recoveryData,
            },
          });
        } else if (position && input.side === 'SELL' && !independentExit && executedQuantity > 0) {
          position = await this.applyParentSellFill(tx, {
            order: { side: 'SELL' },
            position,
            subPosition: null,
            strategy,
            deltaQuantity: executedQuantity,
            deltaQuote: quoteAmount,
            averageFillPrice,
          });
        }

        if (!position) throw new BadRequestException('Unable to resolve a Testnet position for the order');

        if (independentEntry && executedQuantity > 0) {
          const level = input.level ?? 1;
          const existingSubPosition = await tx.tradingSubPosition.findUnique({
            where: { positionId_level: { positionId: position.id, level } },
          });
          const newQuantity = Number(existingSubPosition?.quantity ?? 0) + executedQuantity;
          const newCost = Number(existingSubPosition?.costQuote ?? 0) + quoteAmount;
          const newAverage = newQuantity > 0 ? newCost / newQuantity : 0;
          const takeProfitPrice = newAverage * (1 + Number(strategy.takeProfitPercent) / 100);
          const subPosition = existingSubPosition
            ? await tx.tradingSubPosition.update({
                where: { id: existingSubPosition.id },
                data: {
                  status: 'OPEN',
                  quantity: newQuantity,
                  costQuote: newCost,
                  entryPrice: newAverage,
                  takeProfitPrice,
                  closedAt: null,
                },
              })
            : await tx.tradingSubPosition.create({
                data: {
                  positionId: position.id,
                  level,
                  status: 'OPEN',
                  quantity: executedQuantity,
                  costQuote: quoteAmount,
                  entryPrice: averageFillPrice,
                  takeProfitPrice,
                },
              });
          subPositionId = subPosition.id;
          if (!existingSubPosition) {
            const dcaCount = Number(position.dcaCount) + 1;
            const nextDcaPrice = averageFillPrice * (1 - Number(strategy.dcaStepPercent) / 100);
            position = await tx.tradingPosition.update({
              where: { id: position.id },
              data: { dcaCount, nextDcaPrice },
            });
          }
        } else if (independentExit && independentSubPosition && executedQuantity > 0) {
          await this.applyIndependentSellFill(tx, {
            order: { side: 'SELL' },
            position,
            subPosition: independentSubPosition,
            strategy,
            deltaQuantity: executedQuantity,
            deltaQuote: quoteAmount,
            averageFillPrice,
          });
        }

        const order = await tx.tradingOrder.create({
          data: {
            userId,
            positionId: position.id,
            subPositionId,
            exchangeOrderId: exchangeOrder.orderId ? String(exchangeOrder.orderId) : null,
            clientOrderId: exchangeOrder.clientOrderId ?? clientOrderId,
            side: input.side,
            type: 'MARKET',
            status,
            level: input.level ?? (position.dcaCount + 1),
            independent: Boolean(independentEntry || independentExit),
            quantity: input.quantity,
            price: averageFillPrice || null,
            filledQuantity: executedQuantity,
            quoteAmount,
            averageFillPrice: averageFillPrice || null,
            accountedFilledQuantity: executedQuantity,
            accountedQuoteAmount: quoteAmount,
          },
          include: { position: true, subPosition: true },
        });

        if (claimedActionId) {
          await tx.strategyAction.update({
            where: { id: claimedActionId },
            data: {
              orderId: order.id,
              positionId: position.id,
              subPositionId,
              status: status === 'FILLED' ? 'COMPLETED' : 'SUBMITTED',
              completedAt: status === 'FILLED' ? new Date() : null,
            },
          });
        }

        return order;
      });

      this.notifications.publish({
        event: status === 'FILLED' ? 'TESTNET_ORDER_FILLED' : 'TESTNET_ORDER_SUBMITTED',
        message: status === 'FILLED'
          ? `Testnet ${input.side} market order filled for ${strategy.symbol}.`
          : `Testnet ${input.side} market order submitted for ${strategy.symbol}.`,
        severity: 'INFO',
        userId,
        strategyId: strategy.id,
        positionId: savedOrder.positionId,
        orderId: savedOrder.id,
        metadata: {
          actionId: claimedActionId,
          actionType: actionType ?? null,
          clientOrderId: savedOrder.clientOrderId,
          exchangeOrderId: savedOrder.exchangeOrderId,
          symbol: strategy.symbol,
          side: input.side,
          status,
          level: savedOrder.level,
          independent: savedOrder.independent,
          requestedQuantity: input.quantity,
          filledQuantity: executedQuantity,
          quoteAmount,
          averageFillPrice: averageFillPrice || null,
        },
      });

      return {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        environment: strategy.environment,
        paperTrading: strategy.paperTrading,
        clientOrderId,
        savedOrder,
        exchangeOrder,
        actionId: claimedActionId,
      };
    } catch (error: unknown) {
      if (claimedActionId) {
        await this.strategyActions.markFailed(claimedActionId, error);
      }
      throw error;
    }
  }

  async listOrders(userId: string, limit = 100) {
    return this.prisma.tradingOrder.findMany({
      where: {
        userId,
        position: {
          strategy: {
            environment: 'TESTNET',
            paperTrading: false,
          },
        },
      },
      include: {
        position: {
          select: {
            id: true,
            symbol: true,
            status: true,
            strategy: {
              select: {
                id: true,
                name: true,
                status: true,
                environment: true,
                paperTrading: true,
              },
            },
          },
        },
        subPosition: {
          select: {
            id: true,
            level: true,
            status: true,
          },
        },
        strategyAction: {
          select: {
            id: true,
            type: true,
            status: true,
            actionKey: true,
            triggerPrice: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async listPositions(userId: string, limit = 100) {
    return this.prisma.tradingPosition.findMany({
      where: {
        userId,
        strategy: {
          environment: 'TESTNET',
          paperTrading: false,
        },
      },
      include: {
        strategy: {
          select: {
            id: true,
            name: true,
            symbol: true,
            status: true,
            environment: true,
            paperTrading: true,
            riskBudgetQuote: true,
            baseOrderQuote: true,
            maxDcaOrders: true,
            dcaStepPercent: true,
            dcaMultiplier: true,
            takeProfitPercent: true,
            independentFromLevel: true,
            recoveryEnabled: true,
            recoveryMaxOrders: true,
            recoveryStepPercents: true,
            recoveryMultipliers: true,
            recoveryTakeProfitPercent: true,
          },
        },
        subPositions: {
          orderBy: { level: 'asc' },
        },
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
      orderBy: { openedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async syncOrder(userId: string, tradingOrderId: string) {
    const order = await this.prisma.tradingOrder.findFirst({
      where: { id: tradingOrderId, userId },
      include: { position: { include: { strategy: true } }, strategyAction: true, subPosition: true },
    });

    if (!order) throw new NotFoundException('Trading order not found');
    if (order.position.strategy.paperTrading || order.position.strategy.environment !== 'TESTNET') {
      throw new BadRequestException('Only Binance testnet orders can be synchronized');
    }
    if (!order.exchangeOrderId) {
      throw new BadRequestException('Trading order does not have an exchange order identifier');
    }

    const exchangeOrder = (await this.testnetOrders.getOrder(
      userId,
      order.position.symbol,
      order.exchangeOrderId,
    )) as BinanceOrderResponse;

    const executedQuantity = Number(exchangeOrder.executedQty ?? 0);
    const quoteAmount = Number(exchangeOrder.cummulativeQuoteQty ?? 0);
    const averageFillPrice = this.calculateAverageFillPrice(exchangeOrder, executedQuantity, quoteAmount);
    const status = this.mapOrderStatus(exchangeOrder.status);
    const previousStatus = order.status;
    const accountedQuantity = Number(order.accountedFilledQuantity ?? 0);
    const accountedQuote = Number(order.accountedQuoteAmount ?? 0);
    const deltaQuantity = Math.max(executedQuantity - accountedQuantity, 0);
    const deltaQuote = Math.max(quoteAmount - accountedQuote, 0);

    const result = await this.prisma.$transaction(async (tx) => {
      let updatedPosition: any = order.position;
      let updatedSubPosition = order.subPosition;

      if (deltaQuantity > 0) {
        if (order.independent && order.side === 'BUY') {
          const level = Number(order.level);
          const current = updatedSubPosition ?? await tx.tradingSubPosition.findUnique({
            where: { positionId_level: { positionId: order.positionId, level } },
          });
          const newQuantity = Number(current?.quantity ?? 0) + deltaQuantity;
          const newCost = Number(current?.costQuote ?? 0) + deltaQuote;
          const newAverage = newQuantity > 0 ? newCost / newQuantity : 0;
          const takeProfitPrice = newAverage * (1 + Number(order.position.strategy.takeProfitPercent) / 100);
          updatedSubPosition = current
            ? await tx.tradingSubPosition.update({
                where: { id: current.id },
                data: {
                  status: 'OPEN',
                  quantity: newQuantity,
                  costQuote: newCost,
                  entryPrice: newAverage,
                  takeProfitPrice,
                  closedAt: null,
                },
              })
            : await tx.tradingSubPosition.create({
                data: {
                  positionId: order.positionId,
                  level,
                  status: 'OPEN',
                  quantity: deltaQuantity,
                  costQuote: deltaQuote,
                  entryPrice: averageFillPrice,
                  takeProfitPrice,
                },
              });
          if (accountedQuantity === 0) {
            const dcaCount = Number(updatedPosition.dcaCount) + 1;
            updatedPosition = {
              ...updatedPosition,
              ...(await tx.tradingPosition.update({
                where: { id: order.positionId },
                data: {
                  dcaCount,
                  nextDcaPrice: averageFillPrice * (1 - Number(order.position.strategy.dcaStepPercent) / 100),
                },
              })),
              strategy: order.position.strategy,
            };
          }
        } else if (order.independent && order.side === 'SELL') {
          if (!updatedSubPosition) {
            throw new BadRequestException('Independent sub-position is required for fill reconciliation');
          }
          updatedSubPosition = await this.applyIndependentSellFill(tx, {
            order,
            position: order.position,
            subPosition: updatedSubPosition,
            strategy: order.position.strategy,
            deltaQuantity,
            deltaQuote,
            averageFillPrice,
          });
        } else if (order.side === 'BUY') {
          const previousQuantity = Number(updatedPosition.totalQuantity);
          const previousCost = Number(updatedPosition.totalCostQuote);
          const totalQuantity = previousQuantity + deltaQuantity;
          const totalCostQuote = previousCost + deltaQuote;
          const averageEntryPrice = totalQuantity > 0 ? totalCostQuote / totalQuantity : 0;
          const recoveryEntry = order.strategyAction?.type === 'RECOVERY_DCA_ENTRY';
          const dcaCount = Number(updatedPosition.dcaCount) + (!recoveryEntry && accountedQuantity === 0 ? 1 : 0);
          const recoveryDcaCount = Number(updatedPosition.recoveryDcaCount) + (recoveryEntry && accountedQuantity === 0 ? 1 : 0);
          const parentTriggers = this.calculateParentTriggers(
            order.position.strategy,
            totalQuantity,
            totalCostQuote,
            averageEntryPrice,
            dcaCount,
          );
          let recoveryData: Record<string, unknown> = {};
          if (recoveryEntry) {
            const subPositions = await tx.tradingSubPosition.findMany({
              where: { positionId: order.positionId, status: 'OPEN' },
              orderBy: { level: 'asc' },
            });
            const anchor = subPositions.find((item: any) => Number(item.level) === Number(order.position.strategy.independentFromLevel));
            const anchorPrice = Number(updatedPosition.recoveryAnchorPrice ?? anchor?.entryPrice ?? 0);
            const basket = this.recoveryStrategy.basketTotals({ totalQuantity, totalCostQuote }, subPositions);
            const nextLeg = this.recoveryStrategy.nextLeg(order.position.strategy, {
              recoveryDcaCount,
              anchorPrice,
              baseOrderQuote: Number(order.position.strategy.baseOrderQuote),
              remainingRiskBudget: Math.max(Number(order.position.strategy.riskBudgetQuote) - basket.costQuote, 0),
            });
            recoveryData = {
              recoveryMode: true,
              recoveryDcaCount,
              recoveryAnchorPrice: anchorPrice,
              recoveryTakeProfitPrice: this.recoveryStrategy.globalTakeProfit(order.position.strategy, basket),
              nextDcaPrice: nextLeg?.triggerPrice ?? null,
              takeProfitPrice: null,
            };
          }
          updatedPosition = {
            ...updatedPosition,
            ...(await tx.tradingPosition.update({
              where: { id: order.positionId },
              data: {
                totalQuantity,
                totalCostQuote,
                averageEntryPrice,
                dcaCount,
                nextDcaPrice: recoveryEntry ? undefined : parentTriggers.nextDcaPrice,
                takeProfitPrice: recoveryEntry ? undefined : parentTriggers.takeProfitPrice,
                ...recoveryData,
              },
            })),
            strategy: order.position.strategy,
          };
        } else {
          updatedPosition = {
            ...updatedPosition,
            ...(await this.applyParentSellFill(tx, {
              order,
              position: updatedPosition,
              subPosition: null,
              strategy: order.position.strategy,
              deltaQuantity,
              deltaQuote,
              averageFillPrice,
            })),
            strategy: order.position.strategy,
          };
        }
      }

      const updatedOrder = await tx.tradingOrder.update({
        where: { id: order.id },
        data: {
          status,
          subPositionId: updatedSubPosition?.id ?? order.subPositionId,
          filledQuantity: executedQuantity,
          quoteAmount,
          averageFillPrice: averageFillPrice || null,
          price: averageFillPrice || order.price,
          accountedFilledQuantity: accountedQuantity + deltaQuantity,
          accountedQuoteAmount: accountedQuote + deltaQuote,
        },
      });

      if (order.strategyAction) {
        await tx.strategyAction.update({
          where: { id: order.strategyAction.id },
          data: {
            positionId: updatedPosition.id,
            subPositionId: updatedSubPosition?.id ?? order.strategyAction.subPositionId,
            status: status === 'FILLED' ? 'COMPLETED' : 'SUBMITTED',
            completedAt: status === 'FILLED' ? new Date() : null,
          },
        });
      }

      return { tradingOrder: updatedOrder, exchangeOrder };
    });

    if (status !== previousStatus || deltaQuantity > 0) {
      const terminalFailure = status === 'REJECTED' || status === 'CANCELLED';
      this.notifications.publish({
        event: status === 'FILLED'
          ? 'TESTNET_ORDER_SYNC_FILLED'
          : terminalFailure
            ? 'TESTNET_ORDER_SYNC_TERMINAL'
            : 'TESTNET_ORDER_SYNC_UPDATED',
        message: status === 'FILLED'
          ? `Testnet order synchronization confirmed a fill for ${order.position.symbol}.`
          : terminalFailure
            ? `Testnet order synchronization ended with status ${status} for ${order.position.symbol}.`
            : `Testnet order synchronization updated status to ${status} for ${order.position.symbol}.`,
        severity: terminalFailure ? 'WARNING' : 'INFO',
        userId,
        strategyId: order.position.strategyId,
        positionId: order.positionId,
        orderId: order.id,
        metadata: {
          actionId: order.strategyAction?.id ?? null,
          symbol: order.position.symbol,
          side: order.side,
          previousStatus,
          status,
          clientOrderId: order.clientOrderId,
          exchangeOrderId: order.exchangeOrderId,
          filledQuantity: executedQuantity,
          quoteAmount,
          deltaQuantity,
          deltaQuote,
          averageFillPrice: averageFillPrice || null,
        },
      });
    }

    return result;
  }

  private async applyParentSellFill(tx: any, context: FillAccountingContext) {
    const { position, strategy, deltaQuantity, deltaQuote, averageFillPrice } = context;
    const previousQuantity = Number(position.totalQuantity);
    const previousCost = Number(position.totalCostQuote);
    const soldQuantity = Math.min(deltaQuantity, previousQuantity);
    const allocatedCost = previousQuantity > 0 ? (previousCost * soldQuantity) / previousQuantity : 0;
    const proceeds = deltaQuote > 0 ? deltaQuote : soldQuantity * averageFillPrice;
    const remainingQuantity = Math.max(previousQuantity - soldQuantity, 0);
    const remainingCost = Math.max(previousCost - allocatedCost, 0);
    const closed = remainingQuantity <= 1e-12;
    const remainingAverage = closed ? 0 : remainingCost / remainingQuantity;
    const parentTriggers = closed
      ? { nextDcaPrice: null, takeProfitPrice: null }
      : this.calculateParentTriggers(
          strategy,
          remainingQuantity,
          remainingCost,
          remainingAverage,
          Number(position.dcaCount),
        );

    return tx.tradingPosition.update({
      where: { id: position.id },
      data: {
        status: closed ? 'CLOSED' : 'OPEN',
        totalQuantity: closed ? 0 : remainingQuantity,
        totalCostQuote: closed ? 0 : remainingCost,
        averageEntryPrice: remainingAverage,
        realizedPnlQuote: Number(position.realizedPnlQuote) + proceeds - allocatedCost,
        closedAt: closed ? new Date() : null,
        nextDcaPrice: parentTriggers.nextDcaPrice,
        takeProfitPrice: parentTriggers.takeProfitPrice,
      },
    });
  }

  private async applyIndependentSellFill(tx: any, context: FillAccountingContext) {
    const { subPosition, deltaQuantity, deltaQuote, averageFillPrice } = context;
    const previousQuantity = Number(subPosition.quantity);
    const previousCost = Number(subPosition.costQuote);
    const soldQuantity = Math.min(deltaQuantity, previousQuantity);
    const allocatedCost = previousQuantity > 0 ? (previousCost * soldQuantity) / previousQuantity : 0;
    const proceeds = deltaQuote > 0 ? deltaQuote : soldQuantity * averageFillPrice;
    const remainingQuantity = Math.max(previousQuantity - soldQuantity, 0);
    const remainingCost = Math.max(previousCost - allocatedCost, 0);
    const closed = remainingQuantity <= 1e-12;

    return tx.tradingSubPosition.update({
      where: { id: subPosition.id },
      data: {
        status: closed ? 'CLOSED' : 'OPEN',
        quantity: closed ? 0 : remainingQuantity,
        costQuote: closed ? 0 : remainingCost,
        entryPrice: closed ? 0 : remainingCost / remainingQuantity,
        realizedPnlQuote: Number(subPosition.realizedPnlQuote) + proceeds - allocatedCost,
        closedAt: closed ? new Date() : null,
      },
    });
  }

  private calculateAverageFillPrice(order: BinanceOrderResponse, executedQuantity: number, quoteAmount: number) {
    if (executedQuantity > 0 && quoteAmount > 0) return quoteAmount / executedQuantity;
    const fills = order.fills ?? [];
    const totalQuantity = fills.reduce((sum, fill) => sum + Number(fill.qty ?? 0), 0);
    const totalQuote = fills.reduce(
      (sum, fill) => sum + Number(fill.price ?? 0) * Number(fill.qty ?? 0),
      0,
    );
    if (totalQuantity > 0 && totalQuote > 0) return totalQuote / totalQuantity;
    return Number(order.price ?? 0);
  }

  private mapOrderStatus(status?: string) {
    switch ((status ?? '').toUpperCase()) {
      case 'NEW':
      case 'PENDING_NEW':
        return 'PENDING' as const;
      case 'PARTIALLY_FILLED':
        return 'PARTIALLY_FILLED' as const;
      case 'FILLED':
        return 'FILLED' as const;
      case 'CANCELED':
      case 'CANCELLED':
        return 'CANCELLED' as const;
      case 'REJECTED':
      case 'EXPIRED':
        return 'REJECTED' as const;
      default:
        return 'FAILED' as const;
    }
  }

  private calculateParentTriggers(
    strategy: {
      dcaStepPercent: unknown;
      dcaMultiplier: unknown;
      takeProfitPercent: unknown;
    },
    totalQuantity: number,
    totalCostQuote: number,
    averageEntryPrice: number,
    dcaCount: number,
  ) {
    if (totalQuantity <= 0 || totalCostQuote <= 0 || averageEntryPrice <= 0) {
      return { nextDcaPrice: null, takeProfitPrice: null };
    }

    const dcaStepPercent = Number(strategy.dcaStepPercent);
    const dcaMultiplier = Number(strategy.dcaMultiplier);
    const takeProfitPercent = Number(strategy.takeProfitPercent);
    const nextStepMultiplier = Math.pow(dcaMultiplier, dcaCount);
    return {
      nextDcaPrice:
        averageEntryPrice * (1 - (dcaStepPercent * nextStepMultiplier) / 100),
      takeProfitPrice:
        averageEntryPrice * (1 + takeProfitPercent / 100),
    };
  }
}
