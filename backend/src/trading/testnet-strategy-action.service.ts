import { BadRequestException, Injectable } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

export type ClaimTestnetStrategyActionInput = {
  strategyId: string;
  positionId?: string | null;
  type: 'INITIAL_ENTRY' | 'DCA_ENTRY' | 'INDEPENDENT_ENTRY' | 'RECOVERY_DCA_ENTRY' | 'PARENT_EXIT' | 'INDEPENDENT_EXIT';
  side: 'BUY' | 'SELL';
  quantity?: number | null;
  quoteAmount?: number | null;
  level?: number | null;
  triggerPrice?: number | null;
  idempotencyKey: string;
};

type FailureCategory =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'EXCHANGE_TEMPORARY'
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'INSUFFICIENT_BALANCE'
  | 'UNKNOWN';

type ClassifiedFailure = {
  category: FailureCategory;
  retryable: boolean;
  message: string;
};

@Injectable()
export class TestnetStrategyActionService {
  private readonly baseRetryDelayMs = 30_000;
  private readonly maxRetryDelayMs = 15 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async claim(userId: string, input: ClaimTestnetStrategyActionInput) {
    if (!input.idempotencyKey.trim()) {
      throw new BadRequestException('Strategy action idempotency key is required');
    }

    const strategy = await this.prisma.tradingStrategy.findFirst({
      where: { id: input.strategyId, userId },
      select: { id: true, environment: true, paperTrading: true },
    });

    if (!strategy) throw new BadRequestException('Strategy not found');
    if (strategy.paperTrading || strategy.environment !== 'TESTNET') {
      throw new BadRequestException('Only Binance testnet strategies can claim exchange actions');
    }

    if (input.positionId) {
      const position = await this.prisma.tradingPosition.findFirst({
        where: { id: input.positionId, strategyId: strategy.id, userId },
        select: { id: true },
      });
      if (!position) throw new BadRequestException('Strategy position not found');
    }

    const existing = await this.prisma.strategyAction.findUnique({
      where: { actionKey: input.idempotencyKey },
    });

    if (existing) return { action: existing, claimed: false };

    const blockingAction = await this.prisma.strategyAction.findFirst({
      where: {
        strategyId: strategy.id,
        status: { in: ['PENDING', 'SUBMITTED'] },
        NOT: { actionKey: input.idempotencyKey },
        OR: input.positionId
          ? [
              { positionId: input.positionId },
              { positionId: null, type: 'INITIAL_ENTRY' },
            ]
          : [{ positionId: null }, { type: 'INITIAL_ENTRY' }],
      },
      include: { order: true },
      orderBy: { createdAt: 'asc' },
    });

    if (blockingAction) {
      throw new BadRequestException(
        `Another testnet action is still unresolved (${blockingAction.type}:${blockingAction.status})`,
      );
    }

    if (input.positionId) {
      const blockingOrder = await this.prisma.tradingOrder.findFirst({
        where: {
          positionId: input.positionId,
          status: { in: ['PENDING', 'PARTIALLY_FILLED'] },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (blockingOrder) {
        throw new BadRequestException(
          `Another testnet order is still unresolved (${blockingOrder.clientOrderId}:${blockingOrder.status})`,
        );
      }
    }

    try {
      const action = await this.prisma.strategyAction.create({
        data: {
          userId,
          strategyId: strategy.id,
          positionId: input.positionId ?? null,
          type: input.type,
          status: 'PENDING',
          side: input.side,
          quantity: input.quantity ?? null,
          quoteAmount: input.quoteAmount ?? null,
          level: input.level ?? null,
          triggerPrice: input.triggerPrice ?? null,
          actionKey: input.idempotencyKey,
          independent: input.type === 'INDEPENDENT_ENTRY' || input.type === 'INDEPENDENT_EXIT',
          attemptCount: 0,
          retryable: false,
          failureCategory: null,
          lastAttemptedAt: null,
          nextRetryAt: null,
        },
      });

      return { action, claimed: true };
    } catch (error: unknown) {
      const raced = await this.prisma.strategyAction.findUnique({
        where: { actionKey: input.idempotencyKey },
      });
      if (raced) return { action: raced, claimed: false };
      throw error;
    }
  }

  async markSubmitted(actionId: string, tradingOrderId: string) {
    return this.prisma.strategyAction.update({
      where: { id: actionId },
      data: {
        status: 'SUBMITTED',
        orderId: tradingOrderId,
        errorMessage: null,
        retryable: false,
        failureCategory: null,
        nextRetryAt: null,
      },
    });
  }

  async markCompleted(actionId: string) {
    return this.prisma.strategyAction.update({
      where: { id: actionId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        errorMessage: null,
        retryable: false,
        failureCategory: null,
        nextRetryAt: null,
      },
    });
  }

  async markAttemptStarted(actionId: string) {
    return this.prisma.strategyAction.update({
      where: { id: actionId },
      data: {
        lastAttemptedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });
  }

  async markFailed(actionId: string, error: unknown) {
    const classified = this.classifyFailure(error);
    const current = await this.prisma.strategyAction.findUnique({
      where: { id: actionId },
      select: { attemptCount: true, maxAttempts: true },
    });

    if (!current) throw new BadRequestException('Strategy action not found');

    const exhausted = current.attemptCount >= current.maxAttempts;
    const permanentlyFailed = !classified.retryable || exhausted;
    const nextRetryAt = permanentlyFailed ? null : this.calculateNextRetryAt(current.attemptCount);

    const action = await this.prisma.strategyAction.update({
      where: { id: actionId },
      data: {
        status: permanentlyFailed ? 'PERMANENTLY_FAILED' : 'FAILED',
        errorMessage: classified.message.slice(0, 2000),
        failureCategory: classified.category,
        retryable: !permanentlyFailed,
        nextRetryAt,
        completedAt: permanentlyFailed ? new Date() : null,
      },
      select: {
        id: true,
        userId: true,
        strategyId: true,
        positionId: true,
        orderId: true,
        type: true,
        side: true,
        level: true,
        actionKey: true,
        attemptCount: true,
        maxAttempts: true,
        nextRetryAt: true,
        failureCategory: true,
        retryable: true,
        status: true,
      },
    });

    this.notifications.publish({
      event: permanentlyFailed
        ? 'TESTNET_STRATEGY_ACTION_PERMANENTLY_FAILED'
        : 'TESTNET_STRATEGY_ACTION_RETRY_SCHEDULED',
      message: permanentlyFailed
        ? `Testnet strategy action ${action.type} failed permanently.`
        : `Testnet strategy action ${action.type} will be retried.`,
      severity: permanentlyFailed ? 'CRITICAL' : 'WARNING',
      userId: action.userId,
      strategyId: action.strategyId,
      positionId: action.positionId ?? undefined,
      orderId: action.orderId ?? undefined,
      metadata: {
        actionId: action.id,
        actionKey: action.actionKey,
        side: action.side,
        level: action.level,
        category: action.failureCategory,
        attemptCount: action.attemptCount,
        maxAttempts: action.maxAttempts,
        nextRetryAt: action.nextRetryAt?.toISOString() ?? null,
        error: classified.message.slice(0, 2000),
      },
    });

    return action;
  }

  listRecoverable(limit = 100) {
    const now = new Date();
    return this.prisma.strategyAction.findMany({
      where: {
        OR: [
          { status: { in: ['PENDING', 'SUBMITTED'] } },
          { status: 'FAILED', retryable: true, nextRetryAt: { lte: now } },
        ],
      },
      include: { strategy: true, position: true, order: true },
      orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async listUserRecoverable(userId: string, limit = 100) {
    return this.prisma.strategyAction.findMany({
      where: {
        userId,
        strategy: { environment: 'TESTNET', paperTrading: false },
        status: { in: ['PENDING', 'SUBMITTED', 'FAILED', 'PERMANENTLY_FAILED'] },
      },
      include: { strategy: true, position: true, order: true, subPosition: true },
      orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async manualRetry(userId: string, actionId: string) {
    const action = await this.prisma.strategyAction.findFirst({
      where: {
        id: actionId,
        userId,
        strategy: { environment: 'TESTNET', paperTrading: false },
      },
      include: { order: true },
    });
    if (!action) throw new BadRequestException('Testnet strategy action not found');
    if (!['FAILED', 'PERMANENTLY_FAILED'].includes(action.status)) {
      throw new BadRequestException('Only failed Testnet actions can be retried manually');
    }
    if (action.order?.status === 'PENDING' || action.order?.status === 'PARTIALLY_FILLED') {
      throw new BadRequestException('The linked Testnet order is still unresolved');
    }

    const updated = await this.prisma.strategyAction.update({
      where: { id: action.id },
      data: {
        status: 'PENDING',
        retryable: false,
        failureCategory: null,
        errorMessage: null,
        nextRetryAt: null,
        completedAt: null,
        lastAttemptedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });

    this.notifications.publish({
      event: 'TESTNET_STRATEGY_ACTION_MANUAL_RETRY',
      message: `Manual retry requested for Testnet strategy action ${action.type}.`,
      severity: 'WARNING',
      userId,
      strategyId: action.strategyId,
      positionId: action.positionId ?? undefined,
      orderId: action.orderId ?? undefined,
      metadata: { actionId: action.id, actionKey: action.actionKey },
    });

    return updated;
  }

  async cancelRetry(userId: string, actionId: string) {
    const action = await this.prisma.strategyAction.findFirst({
      where: {
        id: actionId,
        userId,
        strategy: { environment: 'TESTNET', paperTrading: false },
      },
    });
    if (!action) throw new BadRequestException('Testnet strategy action not found');
    if (!['FAILED', 'PENDING'].includes(action.status)) {
      throw new BadRequestException('Only pending or retryable failed actions can be cancelled');
    }

    return this.prisma.strategyAction.update({
      where: { id: action.id },
      data: {
        status: 'CANCELLED',
        retryable: false,
        nextRetryAt: null,
        completedAt: new Date(),
        errorMessage: 'Cancelled manually',
      },
    });
  }

  async acknowledgePermanentFailure(userId: string, actionId: string) {
    const action = await this.prisma.strategyAction.findFirst({
      where: {
        id: actionId,
        userId,
        status: 'PERMANENTLY_FAILED',
        strategy: { environment: 'TESTNET', paperTrading: false },
      },
    });
    if (!action) throw new BadRequestException('Permanent Testnet failure not found');

    this.notifications.publish({
      event: 'TESTNET_STRATEGY_ACTION_FAILURE_ACKNOWLEDGED',
      message: `Permanent failure acknowledged for Testnet action ${action.type}.`,
      severity: 'INFO',
      userId,
      strategyId: action.strategyId,
      positionId: action.positionId ?? undefined,
      orderId: action.orderId ?? undefined,
      metadata: { actionId: action.id, actionKey: action.actionKey },
    });

    return { acknowledged: true, actionId: action.id };
  }

  async claimRetry(actionId: string) {
    const now = new Date();
    const result = await this.prisma.strategyAction.updateMany({
      where: {
        id: actionId,
        status: 'FAILED',
        retryable: true,
        nextRetryAt: { lte: now },
      },
      data: {
        status: 'PENDING',
        retryable: false,
        nextRetryAt: null,
        lastAttemptedAt: now,
        attemptCount: { increment: 1 },
      },
    });

    return result.count === 1;
  }

  private calculateNextRetryAt(attemptCount: number) {
    const exponent = Math.max(attemptCount - 1, 0);
    const delay = Math.min(this.baseRetryDelayMs * Math.pow(2, exponent), this.maxRetryDelayMs);
    return new Date(Date.now() + delay);
  }

  private classifyFailure(error: unknown): ClassifiedFailure {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown testnet strategy action failure');
    const normalized = message.toLowerCase();
    const statusCode = this.extractStatusCode(error);

    if (normalized.includes('timeout') || normalized.includes('timed out') || statusCode === 408) {
      return { category: 'TIMEOUT', retryable: true, message };
    }
    if (
      normalized.includes('econnreset') ||
      normalized.includes('econnrefused') ||
      normalized.includes('enotfound') ||
      normalized.includes('network') ||
      normalized.includes('socket')
    ) {
      return { category: 'NETWORK', retryable: true, message };
    }
    if (statusCode === 429 || normalized.includes('rate limit') || normalized.includes('too many requests')) {
      return { category: 'RATE_LIMIT', retryable: true, message };
    }
    if ((statusCode !== null && statusCode >= 500) || normalized.includes('temporarily unavailable')) {
      return { category: 'EXCHANGE_TEMPORARY', retryable: true, message };
    }
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      normalized.includes('api key') ||
      normalized.includes('signature') ||
      normalized.includes('authentication') ||
      normalized.includes('permission')
    ) {
      return { category: 'AUTHENTICATION', retryable: false, message };
    }
    if (normalized.includes('insufficient balance') || normalized.includes('insufficient funds')) {
      return { category: 'INSUFFICIENT_BALANCE', retryable: false, message };
    }
    if (
      normalized.includes('invalid') ||
      normalized.includes('validation') ||
      normalized.includes('quantity') ||
      normalized.includes('notional') ||
      normalized.includes('symbol')
    ) {
      return { category: 'VALIDATION', retryable: false, message };
    }

    return { category: 'UNKNOWN', retryable: false, message };
  }

  private extractStatusCode(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };
    const raw = candidate.statusCode ?? candidate.status ?? candidate.response?.status;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
