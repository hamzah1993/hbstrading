import { BadRequestException, Injectable } from '@nestjs/common';

export type FillAccountingContext = {
  order: any;
  position: any;
  subPosition: any | null;
  strategy: any;
  deltaQuantity: number;
  deltaQuote: number;
  averageFillPrice: number;
};

type TriggerValues = {
  nextDcaPrice: number | null;
  takeProfitPrice: number | null;
};

@Injectable()
export class TestnetFillAccountingService {
  calculateParentTriggers(
    strategy: any,
    averageEntryPrice: number,
    dcaCount: number,
  ): TriggerValues {
    if (!Number.isFinite(averageEntryPrice) || averageEntryPrice <= 0) {
      return { nextDcaPrice: null, takeProfitPrice: null };
    }

    const stepPercent = Number(strategy.dcaStepPercent);
    const multiplier = Number(strategy.dcaMultiplier);
    const takeProfitPercent = Number(strategy.takeProfitPercent);

    if (!Number.isFinite(stepPercent) || stepPercent <= 0) {
      throw new BadRequestException('DCA step percent must be greater than zero');
    }
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new BadRequestException('DCA multiplier must be greater than zero');
    }
    if (!Number.isFinite(takeProfitPercent) || takeProfitPercent <= 0) {
      throw new BadRequestException('Take-profit percent must be greater than zero');
    }

    const nextStepMultiplier = Math.pow(multiplier, Math.max(dcaCount, 0));
    const nextDcaPrice = averageEntryPrice * (1 - (stepPercent * nextStepMultiplier) / 100);
    const takeProfitPrice = averageEntryPrice * (1 + takeProfitPercent / 100);

    return {
      nextDcaPrice: nextDcaPrice > 0 ? nextDcaPrice : null,
      takeProfitPrice,
    };
  }

  calculateIndependentTakeProfit(strategy: any, averageEntryPrice: number): number {
    if (!Number.isFinite(averageEntryPrice) || averageEntryPrice <= 0) {
      throw new BadRequestException('Independent average entry price must be greater than zero');
    }
    const takeProfitPercent = Number(strategy.takeProfitPercent);
    if (!Number.isFinite(takeProfitPercent) || takeProfitPercent <= 0) {
      throw new BadRequestException('Take-profit percent must be greater than zero');
    }
    return averageEntryPrice * (1 + takeProfitPercent / 100);
  }

  async apply(tx: any, context: FillAccountingContext) {
    const { order, position, subPosition, strategy, deltaQuantity, deltaQuote, averageFillPrice } = context;
    if (!Number.isFinite(deltaQuantity) || deltaQuantity < 0) {
      throw new BadRequestException('Fill quantity delta must be a non-negative number');
    }
    if (!Number.isFinite(deltaQuote) || deltaQuote < 0) {
      throw new BadRequestException('Fill quote delta must be a non-negative number');
    }
    if (deltaQuantity === 0) return { position, subPosition };

    const independentEntry = order.independent && order.side === 'BUY';
    const independentExit = order.independent && order.side === 'SELL';

    if (independentEntry) {
      const level = Number(order.level);
      const existing = subPosition ?? (await tx.tradingSubPosition.findUnique({
        where: { positionId_level: { positionId: position.id, level } },
      }));
      const previousQuantity = Number(existing?.quantity ?? 0);
      const previousCost = Number(existing?.costQuote ?? 0);
      const quantity = previousQuantity + deltaQuantity;
      const costQuote = previousCost + deltaQuote;
      const entryPrice = quantity > 0 ? costQuote / quantity : averageFillPrice;
      const takeProfitPrice = this.calculateIndependentTakeProfit(strategy, entryPrice);
      const saved = existing
        ? await tx.tradingSubPosition.update({
            where: { id: existing.id },
            data: { status: 'OPEN', quantity, costQuote, entryPrice, takeProfitPrice, closedAt: null },
          })
        : await tx.tradingSubPosition.create({
            data: { positionId: position.id, level, status: 'OPEN', quantity, costQuote, entryPrice, takeProfitPrice },
          });
      const firstFillForOrder = Number(order.accountedFilledQuantity ?? 0) === 0;
      if (!firstFillForOrder) return { position, subPosition: saved };
      const dcaCount = Number(position.dcaCount ?? 0) + 1;
      const nextDcaPrice = averageFillPrice * (1 - Number(strategy.dcaStepPercent) / 100);
      const updatedPosition = await tx.tradingPosition.update({
        where: { id: position.id },
        data: { dcaCount, nextDcaPrice },
      });
      return { position: updatedPosition, subPosition: saved };
    }

    if (independentExit) {
      if (!subPosition) throw new BadRequestException('Independent sub-position is required for fill accounting');
      const previousQuantity = Number(subPosition.quantity);
      const previousCost = Number(subPosition.costQuote);
      const soldQuantity = Math.min(deltaQuantity, previousQuantity);
      const allocatedCost = previousQuantity > 0 ? (previousCost * soldQuantity) / previousQuantity : 0;
      const proceeds = deltaQuote > 0 ? deltaQuote : soldQuantity * averageFillPrice;
      const remainingQuantity = Math.max(previousQuantity - soldQuantity, 0);
      const remainingCost = Math.max(previousCost - allocatedCost, 0);
      const closed = remainingQuantity <= 1e-12;
      const remainingAverage = closed ? 0 : remainingCost / remainingQuantity;
      const saved = await tx.tradingSubPosition.update({
        where: { id: subPosition.id },
        data: {
          status: closed ? 'CLOSED' : 'OPEN',
          quantity: closed ? 0 : remainingQuantity,
          costQuote: closed ? 0 : remainingCost,
          entryPrice: remainingAverage,
          takeProfitPrice: closed
            ? null
            : this.calculateIndependentTakeProfit(strategy, remainingAverage),
          realizedPnlQuote: Number(subPosition.realizedPnlQuote) + proceeds - allocatedCost,
          closedAt: closed ? new Date() : null,
        },
      });
      return { position, subPosition: saved };
    }

    if (order.side === 'BUY') {
      const previousQuantity = Number(position.totalQuantity);
      const previousCost = Number(position.totalCostQuote);
      const totalQuantity = previousQuantity + deltaQuantity;
      const totalCostQuote = previousCost + deltaQuote;
      const averageEntryPrice = totalQuantity > 0 ? totalCostQuote / totalQuantity : 0;
      const dcaCount = Number(position.dcaCount) + (order.level > 1 && Number(order.accountedFilledQuantity ?? 0) === 0 ? 1 : 0);
      const triggers = this.calculateParentTriggers(strategy, averageEntryPrice, dcaCount);
      const saved = await tx.tradingPosition.update({
        where: { id: position.id },
        data: {
          totalQuantity,
          totalCostQuote,
          averageEntryPrice,
          dcaCount,
          nextDcaPrice: triggers.nextDcaPrice,
          takeProfitPrice: triggers.takeProfitPrice,
        },
      });
      return { position: saved, subPosition };
    }

    const previousQuantity = Number(position.totalQuantity);
    const previousCost = Number(position.totalCostQuote);
    const soldQuantity = Math.min(deltaQuantity, previousQuantity);
    const allocatedCost = previousQuantity > 0 ? (previousCost * soldQuantity) / previousQuantity : 0;
    const proceeds = deltaQuote > 0 ? deltaQuote : soldQuantity * averageFillPrice;
    const remainingQuantity = Math.max(previousQuantity - soldQuantity, 0);
    const remainingCost = Math.max(previousCost - allocatedCost, 0);
    const closed = remainingQuantity <= 1e-12;
    const averageEntryPrice = closed ? 0 : remainingCost / remainingQuantity;
    const triggers = closed
      ? { nextDcaPrice: null, takeProfitPrice: null }
      : this.calculateParentTriggers(strategy, averageEntryPrice, Number(position.dcaCount));
    const saved = await tx.tradingPosition.update({
      where: { id: position.id },
      data: {
        status: closed ? 'CLOSED' : 'OPEN',
        totalQuantity: closed ? 0 : remainingQuantity,
        totalCostQuote: closed ? 0 : remainingCost,
        averageEntryPrice,
        realizedPnlQuote: Number(position.realizedPnlQuote) + proceeds - allocatedCost,
        closedAt: closed ? new Date() : null,
        nextDcaPrice: triggers.nextDcaPrice,
        takeProfitPrice: triggers.takeProfitPrice,
      },
    });
    return { position: saved, subPosition };
  }
}
