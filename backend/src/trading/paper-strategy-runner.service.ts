import { Injectable } from '@nestjs/common';
import { MarketDataService } from '../market/market-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaperTradingService } from './paper-trading.service';

export type StrategyRunnerAction = 'OPEN' | 'DCA' | 'RECOVERY_DCA' | 'TAKE_PROFIT' | 'RECOVERY_TAKE_PROFIT' | 'HOLD' | 'SKIP' | 'ERROR';

export type StrategyRunnerResult = {
  strategyId: string;
  symbol: string;
  action: StrategyRunnerAction;
  price?: number;
  positionId?: string;
  message?: string;
};

@Injectable()
export class PaperStrategyRunnerService {
  private readonly runningStrategies = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly paperTrading: PaperTradingService,
  ) {}

  async runUserStrategies(userId: string): Promise<StrategyRunnerResult[]> {
    const strategies = await this.prisma.tradingStrategy.findMany({
      where: { userId, status: 'RUNNING', paperTrading: true },
      include: {
        positions: {
          where: { status: 'OPEN' },
          orderBy: { openedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const results: StrategyRunnerResult[] = [];
    for (const strategy of strategies) {
      results.push(await this.runStrategy(userId, strategy));
    }
    return results;
  }

  private async runStrategy(userId: string, strategy: any): Promise<StrategyRunnerResult> {
    if (this.runningStrategies.has(strategy.id)) {
      return {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        action: 'SKIP',
        message: 'Strategy tick is already in progress',
      };
    }

    this.runningStrategies.add(strategy.id);
    try {
      const environment = strategy.environment === 'LIVE' ? 'live' : 'testnet';
      const quote = await this.marketData.getQuote(strategy.symbol, environment);
      const openPosition = strategy.positions[0];

      if (!openPosition) {
        const position = await this.paperTrading.openPosition(userId, {
          strategyId: strategy.id,
          marketPrice: quote.price,
        });
        return {
          strategyId: strategy.id,
          symbol: strategy.symbol,
          action: 'OPEN',
          price: quote.price,
          positionId: position?.id,
        };
      }

      const processed = await this.paperTrading.processPrice(
        userId,
        openPosition.id,
        quote.price,
      );
      const action: Extract<StrategyRunnerAction, 'DCA' | 'RECOVERY_DCA' | 'TAKE_PROFIT' | 'RECOVERY_TAKE_PROFIT' | 'HOLD'> = processed.action;

      return {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        action,
        price: quote.price,
        positionId: processed.position?.id ?? openPosition.id,
      };
    } catch (error) {
      return {
        strategyId: strategy.id,
        symbol: strategy.symbol,
        action: 'ERROR',
        message: error instanceof Error ? error.message : 'Strategy tick failed',
      };
    } finally {
      this.runningStrategies.delete(strategy.id);
    }
  }
}
