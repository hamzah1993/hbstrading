import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RiskBudgetService } from './risk-budget.service';
import { RecoveryStrategyService } from './recovery-strategy.service';

export type StrategyInput = {
  name: string;
  symbol: string;
  environment?: 'TESTNET' | 'LIVE';
  paperTrading?: boolean;
  riskBudgetQuote: number;
  baseOrderQuote: number;
  maxDcaOrders: number;
  dcaStepPercent: number;
  dcaMultiplier: number;
  takeProfitPercent: number;
  independentFromLevel: number;
  recoveryEnabled?: boolean;
  recoveryMaxOrders?: number;
  recoveryStepPercents?: number[];
  recoveryMultipliers?: number[];
  recoveryTakeProfitPercent?: number;
};

@Injectable()
export class StrategyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly riskBudget: RiskBudgetService,
    private readonly recoveryStrategy: RecoveryStrategyService,
  ) {}

  async create(userId: string, input: StrategyInput) {
    const normalized = this.normalize(input);
    this.riskBudget.buildPlan(normalized);

    try {
      return await this.prisma.tradingStrategy.create({
        data: {
          userId,
          name: normalized.name,
          symbol: normalized.symbol,
          environment: normalized.environment,
          mode: normalized.mode,
          paperTrading: normalized.paperTrading,
          riskBudgetQuote: normalized.riskBudgetQuote,
          baseOrderQuote: normalized.baseOrderQuote,
          maxDcaOrders: normalized.maxDcaOrders,
          dcaStepPercent: normalized.dcaStepPercent,
          dcaMultiplier: normalized.dcaMultiplier,
          takeProfitPercent: normalized.takeProfitPercent,
          independentFromLevel: normalized.independentFromLevel,
          recoveryEnabled: normalized.recoveryEnabled,
          recoveryMaxOrders: normalized.recoveryMaxOrders,
          recoveryStepPercents: normalized.recoveryStepPercents,
          recoveryMultipliers: normalized.recoveryMultipliers,
          recoveryTakeProfitPercent: normalized.recoveryTakeProfitPercent,
        },
      });
    } catch (error) {
      this.rethrowFriendlyPrismaError(error);
    }
  }

  list(userId: string) {
    return this.prisma.tradingStrategy.findMany({
      where: { userId },
      include: {
        positions: {
          where: { status: 'OPEN' },
          select: { id: true, status: true, totalCostQuote: true, averageEntryPrice: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(userId: string, strategyId: string, input: Partial<StrategyInput>) {
    const existing = await this.prisma.tradingStrategy.findFirst({ where: { id: strategyId, userId } });
    if (!existing) throw new NotFoundException('Strategy not found');
    if (existing.status === 'RUNNING') throw new BadRequestException('Pause or stop the strategy before editing');

    const merged = this.normalize({
      name: input.name ?? existing.name,
      symbol: input.symbol ?? existing.symbol,
      environment: input.environment ?? existing.environment,
      paperTrading: input.paperTrading ?? existing.paperTrading,
      riskBudgetQuote: input.riskBudgetQuote ?? Number(existing.riskBudgetQuote),
      baseOrderQuote: input.baseOrderQuote ?? Number(existing.baseOrderQuote),
      maxDcaOrders: input.maxDcaOrders ?? existing.maxDcaOrders,
      dcaStepPercent: input.dcaStepPercent ?? Number(existing.dcaStepPercent),
      dcaMultiplier: input.dcaMultiplier ?? Number(existing.dcaMultiplier),
      takeProfitPercent: input.takeProfitPercent ?? Number(existing.takeProfitPercent),
      independentFromLevel: input.independentFromLevel ?? existing.independentFromLevel,
      recoveryEnabled: input.recoveryEnabled ?? existing.recoveryEnabled,
      recoveryMaxOrders: input.recoveryMaxOrders ?? existing.recoveryMaxOrders,
      recoveryStepPercents: input.recoveryStepPercents ?? (existing.recoveryStepPercents as number[]),
      recoveryMultipliers: input.recoveryMultipliers ?? (existing.recoveryMultipliers as number[]),
      recoveryTakeProfitPercent: input.recoveryTakeProfitPercent ?? Number(existing.recoveryTakeProfitPercent),
    });
    this.riskBudget.buildPlan(merged);

    try {
      return await this.prisma.tradingStrategy.update({
        where: { id: strategyId },
        data: merged,
      });
    } catch (error) {
      this.rethrowFriendlyPrismaError(error);
    }
  }

  async setStatus(userId: string, strategyId: string, status: 'RUNNING' | 'PAUSED' | 'STOPPED') {
    const existing = await this.prisma.tradingStrategy.findFirst({ where: { id: strategyId, userId } });
    if (!existing) throw new NotFoundException('Strategy not found');
    return this.prisma.tradingStrategy.update({ where: { id: strategyId }, data: { status } });
  }

  async remove(userId: string, strategyId: string) {
    const existing = await this.prisma.tradingStrategy.findFirst({
      where: { id: strategyId, userId },
      include: { positions: { where: { status: 'OPEN' }, select: { id: true } } },
    });
    if (!existing) throw new NotFoundException('Strategy not found');
    if (existing.positions.length) throw new BadRequestException('Close open positions before deleting the strategy');
    return this.prisma.tradingStrategy.delete({ where: { id: strategyId } });
  }

  private rethrowFriendlyPrismaError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('A bot with this name already exists. Choose another name or edit the existing bot.');
    }
    throw error;
  }

  private normalize(input: StrategyInput) {
    const name = input.name.trim();
    const symbol = input.symbol.replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (!name) throw new BadRequestException('Strategy name is required');
    if (!symbol) throw new BadRequestException('Trading symbol is required');

    const environment = input.environment ?? 'TESTNET';
    const paperTrading = input.paperTrading ?? true;
    const mode = paperTrading
      ? 'PAPER'
      : environment === 'TESTNET'
        ? 'BINANCE_TESTNET'
        : 'BINANCE_LIVE';

    const normalized = {
      name,
      symbol,
      environment,
      mode,
      paperTrading,
      riskBudgetQuote: Number(input.riskBudgetQuote),
      baseOrderQuote: Number(input.baseOrderQuote),
      maxDcaOrders: Number(input.maxDcaOrders),
      dcaStepPercent: Number(input.dcaStepPercent),
      dcaMultiplier: Number(input.dcaMultiplier),
      takeProfitPercent: Number(input.takeProfitPercent),
      independentFromLevel: Number(input.independentFromLevel),
      recoveryEnabled: input.recoveryEnabled ?? true,
      recoveryMaxOrders: Number(input.recoveryMaxOrders ?? 5),
      recoveryStepPercents: (input.recoveryStepPercents ?? [5, 8, 12, 18, 25]).map(Number),
      recoveryMultipliers: (input.recoveryMultipliers ?? [1, 1.5, 2, 3, 5]).map(Number),
      recoveryTakeProfitPercent: Number(input.recoveryTakeProfitPercent ?? 1.5),
    } as const;
    this.recoveryStrategy.normalizeConfig(normalized);
    return normalized;
  }
}
