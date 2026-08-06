import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type TestnetRiskActionType =
  | 'INITIAL_ENTRY'
  | 'DCA_ENTRY'
  | 'INDEPENDENT_ENTRY'
  | 'RECOVERY_DCA_ENTRY'
  | 'PARENT_EXIT'
  | 'INDEPENDENT_EXIT'
  | undefined;

@Injectable()
export class TestnetStrategyRiskService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanExecute(
    userId: string,
    strategy: any,
    openPosition: any | null,
    actionType: TestnetRiskActionType,
    estimatedOrderQuote: number,
  ) {
    if (strategy.mode !== 'BINANCE_TESTNET') {
      throw new BadRequestException('Only BINANCE_TESTNET strategies can place Binance testnet orders');
    }
    if (strategy.paperTrading || strategy.environment !== 'TESTNET') {
      throw new BadRequestException('Strategy mode is inconsistent with Binance testnet execution');
    }

    if (
      estimatedOrderQuote > 0 &&
      strategy.maxOrderQuote !== null &&
      estimatedOrderQuote > Number(strategy.maxOrderQuote)
    ) {
      throw new BadRequestException('Order exceeds the strategy maximum order value');
    }

    if (actionType === 'INITIAL_ENTRY' && !openPosition) {
      const openParents = await this.prisma.tradingPosition.count({
        where: { userId, strategyId: strategy.id, status: 'OPEN' },
      });
      if (openParents >= Number(strategy.maxOpenParentPositions)) {
        throw new BadRequestException('Maximum open parent positions reached');
      }
    }

    const parentExposure = Number(openPosition?.totalCostQuote ?? 0);
    if (
      estimatedOrderQuote > 0 &&
      strategy.maxStrategyExposureQuote !== null &&
      parentExposure + estimatedOrderQuote > Number(strategy.maxStrategyExposureQuote)
    ) {
      throw new BadRequestException('Order would exceed the strategy exposure limit');
    }

    if (actionType === 'INDEPENDENT_ENTRY' && openPosition) {
      const openIndependent = await this.prisma.tradingSubPosition.findMany({
        where: { positionId: openPosition.id, status: 'OPEN' },
        select: { costQuote: true },
      });
      if (openIndependent.length >= Number(strategy.maxOpenIndependentPositions)) {
        throw new BadRequestException('Maximum open independent positions reached');
      }
      const independentExposure = openIndependent.reduce(
        (sum, item) => sum + Number(item.costQuote),
        0,
      );
      if (
        estimatedOrderQuote > 0 &&
        strategy.maxIndependentExposureQuote !== null &&
        independentExposure + estimatedOrderQuote > Number(strategy.maxIndependentExposureQuote)
      ) {
        throw new BadRequestException('Order would exceed the independent exposure limit');
      }
    }

    if (strategy.maxDailyRealizedLossQuote !== null) {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const positions = await this.prisma.tradingPosition.findMany({
        where: { userId, strategyId: strategy.id, updatedAt: { gte: startOfDay } },
        select: { realizedPnlQuote: true },
      });
      const dailyRealized = positions.reduce(
        (sum, item) => sum + Number(item.realizedPnlQuote),
        0,
      );
      if (dailyRealized <= -Number(strategy.maxDailyRealizedLossQuote)) {
        throw new BadRequestException('Daily realized loss limit reached');
      }
    }
  }
}
