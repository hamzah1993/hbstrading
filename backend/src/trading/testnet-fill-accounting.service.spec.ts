import { BadRequestException } from '@nestjs/common';
import { TestnetFillAccountingService } from './testnet-fill-accounting.service';

describe('TestnetFillAccountingService', () => {
  const service = new TestnetFillAccountingService();
  const strategy = {
    dcaMultiplier: 1,
    dcaStepPercent: 5,
    takeProfitPercent: 2,
  };

  const createTx = () => ({
    tradingPosition: {
      update: jest.fn(async ({ data }: any) => ({ id: 'position-1', dcaCount: 0, realizedPnlQuote: 0, ...data })),
    },
    tradingSubPosition: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'sub-1', realizedPnlQuote: 0, ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'sub-1', realizedPnlQuote: 0, ...data })),
    },
  });

  it('adds only the confirmed parent BUY fill delta', async () => {
    const tx = createTx();
    const result = await service.apply(tx, {
      order: { side: 'BUY', independent: false, level: 2, accountedFilledQuantity: 0 },
      position: {
        id: 'position-1',
        totalQuantity: 1,
        totalCostQuote: 100,
        averageEntryPrice: 100,
        dcaCount: 0,
        realizedPnlQuote: 0,
      },
      subPosition: null,
      strategy,
      deltaQuantity: 0.5,
      deltaQuote: 45,
      averageFillPrice: 90,
    });

    expect(result.position).toMatchObject({
      totalQuantity: 1.5,
      totalCostQuote: 145,
      averageEntryPrice: 145 / 1.5,
      dcaCount: 1,
    });
  });

  it('creates an independent sub-position and advances the campaign level once', async () => {
    const tx = createTx();
    const position = { id: 'position-1', totalQuantity: 2, totalCostQuote: 200 };

    const result = await service.apply(tx, {
      order: { side: 'BUY', independent: true, level: 5, accountedFilledQuantity: 0 },
      position,
      subPosition: null,
      strategy,
      deltaQuantity: 1,
      deltaQuote: 80,
      averageFillPrice: 80,
    });

    expect(tx.tradingPosition.update).toHaveBeenCalledWith({
      where: { id: 'position-1' },
      data: { dcaCount: 1, nextDcaPrice: 76 },
    });
    expect(result.position).toMatchObject({ dcaCount: 1, nextDcaPrice: 76 });
    expect(result.subPosition).toMatchObject({
      quantity: 1,
      costQuote: 80,
      entryPrice: 80,
      takeProfitPrice: 81.6,
    });
  });

  it('recalculates the independent average and take-profit after another fill', async () => {
    const tx = createTx();
    tx.tradingSubPosition.findUnique.mockResolvedValue({
      id: 'sub-1',
      quantity: 1,
      costQuote: 100,
      entryPrice: 100,
      takeProfitPrice: 102,
      realizedPnlQuote: 0,
    });

    const result = await service.apply(tx, {
      order: { side: 'BUY', independent: true, level: 5, accountedFilledQuantity: 1 },
      position: { id: 'position-1' },
      subPosition: null,
      strategy,
      deltaQuantity: 1,
      deltaQuote: 80,
      averageFillPrice: 80,
    });

    expect(result.subPosition).toMatchObject({
      quantity: 2,
      costQuote: 180,
      entryPrice: 90,
      takeProfitPrice: 91.8,
    });
  });

  it('partially closes only the selected independent sub-position', async () => {
    const tx = createTx();
    const result = await service.apply(tx, {
      order: { side: 'SELL', independent: true, level: 5 },
      position: { id: 'position-1' },
      subPosition: {
        id: 'sub-1',
        quantity: 2,
        costQuote: 160,
        entryPrice: 80,
        realizedPnlQuote: 0,
      },
      strategy,
      deltaQuantity: 0.5,
      deltaQuote: 50,
      averageFillPrice: 100,
    });

    expect(tx.tradingPosition.update).not.toHaveBeenCalled();
    expect(result.subPosition).toMatchObject({
      status: 'OPEN',
      quantity: 1.5,
      costQuote: 120,
      entryPrice: 80,
      realizedPnlQuote: 10,
    });
  });

  it('closes a parent position from confirmed SELL fill delta', async () => {
    const tx = createTx();
    const result = await service.apply(tx, {
      order: { side: 'SELL', independent: false },
      position: {
        id: 'position-1',
        totalQuantity: 1,
        totalCostQuote: 100,
        averageEntryPrice: 100,
        dcaCount: 0,
        realizedPnlQuote: 0,
      },
      subPosition: null,
      strategy,
      deltaQuantity: 1,
      deltaQuote: 110,
      averageFillPrice: 110,
    });

    expect(result.position).toMatchObject({
      status: 'CLOSED',
      totalQuantity: 0,
      totalCostQuote: 0,
      realizedPnlQuote: 10,
      nextDcaPrice: null,
      takeProfitPrice: null,
    });
  });

  it('rejects negative fill deltas', async () => {
    const tx = createTx();
    await expect(
      service.apply(tx, {
        order: { side: 'BUY', independent: false },
        position: { id: 'position-1' },
        subPosition: null,
        strategy,
        deltaQuantity: -1,
        deltaQuote: 0,
        averageFillPrice: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
