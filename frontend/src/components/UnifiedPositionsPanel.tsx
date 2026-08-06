import { useEffect, useMemo, useState } from 'react';
import { api, type StrategyStatus, type TestnetPosition, type TradingPosition } from '../lib/api';

type Props = {
  token: string;
  initialPositionId?: string | null;
  initialMode?: 'PAPER' | 'TESTNET';
};

type Mode = 'ALL' | 'PAPER' | 'TESTNET';

type UnifiedPosition = {
  id: string;
  source: 'PAPER' | 'TESTNET';
  symbol: string;
  status: TradingPosition['status'];
  strategyId: string;
  strategyName: string;
  strategyStatus?: StrategyStatus;
  totalQuantity: string;
  totalCostQuote: string;
  averageEntryPrice: string;
  realizedPnlQuote: string;
  dcaCount: number;
  recoveryMode: boolean;
  recoveryDcaCount: number;
  recoveryAnchorPrice: string | null;
  recoveryTakeProfitPrice: string | null;
  maxDcaOrders: number;
  nextDcaPrice: string | null;
  takeProfitPrice: string | null;
  openedAt: string;
  orders: Array<{ id: string; status?: string }>;
  subPositions: Array<{ id: string; level: number; status: string; quantity: string; costQuote: string; entryPrice: string; takeProfitPrice: string; realizedPnlQuote: string }>;
};

function money(value: string | number | null | undefined) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(numeric);
}

function number(value: string | number | null | undefined) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(numeric);
}

export function UnifiedPositionsPanel({ token, initialPositionId = null, initialMode }: Props) {
  const [paperPositions, setPaperPositions] = useState<TradingPosition[]>([]);
  const [testnetPositions, setTestnetPositions] = useState<TestnetPosition[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<Mode>(initialMode ?? 'ALL');
  const [openOnly, setOpenOnly] = useState(true);
  const [symbol, setSymbol] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(initialPositionId);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const [paper, testnet] = await Promise.all([
        api.listPaperPositions(token),
        api.listTestnetPositions(token, 250),
      ]);
      setPaperPositions(paper);
      setTestnetPositions(testnet);
      setLastUpdatedAt(new Date());
      setError(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to load positions');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [token]);

  useEffect(() => {
    if (initialPositionId) setExpandedId(initialPositionId);
  }, [initialPositionId]);

  useEffect(() => {
    if (initialMode) setMode(initialMode);
  }, [initialMode]);

  const allPositions = useMemo<UnifiedPosition[]>(() => [
    ...paperPositions.map((position) => ({
      id: position.id,
      source: 'PAPER' as const,
      symbol: position.symbol,
      status: position.status,
      strategyId: position.strategy.id,
      strategyName: position.strategy.name,
      strategyStatus: position.strategy.status,
      totalQuantity: position.totalQuantity,
      totalCostQuote: position.totalCostQuote,
      averageEntryPrice: position.averageEntryPrice,
      realizedPnlQuote: position.realizedPnlQuote,
      dcaCount: position.dcaCount,
      recoveryMode: position.recoveryMode,
      recoveryDcaCount: position.recoveryDcaCount,
      recoveryAnchorPrice: position.recoveryAnchorPrice,
      recoveryTakeProfitPrice: position.recoveryTakeProfitPrice,
      maxDcaOrders: position.strategy.maxDcaOrders,
      nextDcaPrice: position.nextDcaPrice,
      takeProfitPrice: position.takeProfitPrice,
      openedAt: position.openedAt,
      orders: position.orders,
      subPositions: position.subPositions,
    })),
    ...testnetPositions.map((position) => ({
      id: position.id,
      source: 'TESTNET' as const,
      symbol: position.symbol,
      status: position.status,
      strategyId: position.strategy.id,
      strategyName: position.strategy.name,
      strategyStatus: position.strategy.status,
      totalQuantity: position.totalQuantity,
      totalCostQuote: position.totalCostQuote,
      averageEntryPrice: position.averageEntryPrice,
      realizedPnlQuote: position.realizedPnlQuote,
      dcaCount: position.dcaCount,
      recoveryMode: position.recoveryMode,
      recoveryDcaCount: position.recoveryDcaCount,
      recoveryAnchorPrice: position.recoveryAnchorPrice,
      recoveryTakeProfitPrice: position.recoveryTakeProfitPrice,
      maxDcaOrders: position.strategy.maxDcaOrders,
      nextDcaPrice: position.nextDcaPrice,
      takeProfitPrice: position.takeProfitPrice,
      openedAt: position.openedAt,
      orders: position.orders,
      subPositions: position.subPositions,
    })),
  ], [paperPositions, testnetPositions]);

  useEffect(() => {
    const symbols = [...new Set(allPositions.filter((position) => position.status === 'OPEN').map((position) => position.symbol))];
    if (symbols.length === 0) return;
    let cancelled = false;
    const refresh = async () => {
      const results = await Promise.allSettled(symbols.map(async (currentSymbol) => {
        const streamed = await api.getStreamedMarketPrice(token, currentSymbol, 'testnet');
        if (streamed?.price && Number.isFinite(streamed.price)) return [currentSymbol, streamed.price] as const;
        const candles = await api.getMarketCandles(token, currentSymbol, '1m', 1, 'testnet');
        const latestCandle = candles.candles[candles.candles.length - 1];
        return [currentSymbol, latestCandle?.close ?? 0] as const;
      }));
      if (cancelled) return;
      setPrices((current) => {
        const next = { ...current };
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value[1] > 0) next[result.value[0]] = result.value[1];
        }
        return next;
      });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, allPositions]);

  const filtered = useMemo(() => {
    const normalized = symbol.trim().toUpperCase();
    return allPositions.filter((position) => {
      const sourceMatches = mode === 'ALL' || position.source === mode;
      const statusMatches = !openOnly || position.status === 'OPEN';
      const symbolMatches = !normalized || position.symbol.includes(normalized);
      return sourceMatches && statusMatches && symbolMatches;
    });
  }, [allPositions, mode, openOnly, symbol]);

  async function changeStatus(position: UnifiedPosition, status: StrategyStatus) {
    const label = status === 'PAUSED' ? 'pause' : status === 'RUNNING' ? 'resume' : 'stop';
    if (!window.confirm(`${label[0].toUpperCase()}${label.slice(1)} bot “${position.strategyName}”? This changes future automation only and does not close the position.`)) return;
    setBusyId(position.id);
    try {
      await api.setStrategyStatus(token, position.strategyId, status);
      await load(true);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : `Unable to ${label} bot`);
    } finally {
      setBusyId(null);
    }
  }

  async function closePaper(position: UnifiedPosition) {
    const currentPrice = prices[position.symbol] ?? Number(position.averageEntryPrice);
    if (!window.confirm(`Close Paper position ${position.symbol} now at approximately ${currentPrice}? This realizes the current simulated P&L.`)) return;
    setBusyId(position.id);
    try {
      await api.closePaperPosition(token, position.id, currentPrice);
      await load(true);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to close Paper position');
    } finally {
      setBusyId(null);
    }
  }

  async function closeTestnet(position: UnifiedPosition, subPositionId?: string) {
    const currentPrice = prices[position.symbol] ?? Number(position.averageEntryPrice);
    const subPosition = subPositionId ? position.subPositions.find((item) => item.id === subPositionId) : null;
    const quantity = Number(subPosition?.quantity ?? position.totalQuantity);
    const estimatedValue = quantity * currentPrice;
    const target = subPosition ? `independent level #${subPosition.level}` : 'parent position';
    if (!window.confirm(`Close ${target} for ${position.symbol}?\n\nQuantity: ${number(quantity)}\nEstimated value: ${money(estimatedValue)}\n\nThis submits a Binance Testnet SELL market order. The bot must be paused and no order may be pending.`)) return;
    setBusyId(subPositionId ?? position.id);
    try {
      await api.closeTestnetPosition(token, position.id, subPositionId);
      await load(true);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to close Testnet position');
    } finally {
      setBusyId(null);
    }
  }

  async function syncTestnet(position: UnifiedPosition) {
    const pending = position.orders.filter((order) => order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED');
    if (pending.length === 0) {
      setError('This Testnet position has no pending orders to sync.');
      return;
    }
    setBusyId(position.id);
    try {
      await Promise.all(pending.map((order) => api.syncTestnetOrder(token, order.id)));
      await load(true);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to sync Testnet orders');
    } finally {
      setBusyId(null);
    }
  }

  const totals = useMemo(() => {
    const open = allPositions.filter((position) => position.status === 'OPEN');
    const unrealized = open.reduce((sum, position) => {
      const currentPrice = prices[position.symbol] ?? Number(position.averageEntryPrice);
      const independentQuantity = position.subPositions
        .filter((subPosition) => subPosition.status === 'OPEN')
        .reduce((quantity, subPosition) => quantity + Number(subPosition.quantity), 0);
      const independentCost = position.subPositions
        .filter((subPosition) => subPosition.status === 'OPEN')
        .reduce((cost, subPosition) => cost + Number(subPosition.costQuote), 0);
      return sum + currentPrice * (Number(position.totalQuantity) + independentQuantity) - (Number(position.totalCostQuote) + independentCost);
    }, 0);
    const realized = allPositions.reduce((sum, position) => sum + Number(position.realizedPnlQuote), 0);
    return {
      open: open.length,
      paper: allPositions.filter((position) => position.source === 'PAPER').length,
      testnet: allPositions.filter((position) => position.source === 'TESTNET').length,
      unrealized,
      realized,
    };
  }, [allPositions, prices]);

  return (
    <section className="mt-6 space-y-5">
      <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-400/[0.08] via-white/[0.03] to-violet-400/[0.06] p-5 sm:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-300">Unified position operations</p>
            <h3 className="mt-2 text-2xl font-semibold">Paper and Binance Testnet positions</h3>
            <p className="mt-2 text-sm text-slate-400">Prices update every 2 seconds and position state refreshes every 5 seconds. Live-money positions remain disabled.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['ALL', 'PAPER', 'TESTNET'] as Mode[]).map((item) => (
              <button key={item} onClick={() => setMode(item)} className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${mode === item ? 'bg-cyan-400 text-slate-950' : 'border border-white/10 bg-white/[0.04] text-slate-300'}`}>{item === 'ALL' ? 'All' : item === 'PAPER' ? 'Paper' : 'Binance Testnet'}</button>
            ))}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Open positions" value={String(totals.open)} />
          <Metric label="Paper positions" value={String(totals.paper)} />
          <Metric label="Testnet positions" value={String(totals.testnet)} />
          <Metric label="Unrealized P&L" value={money(totals.unrealized)} />
          <Metric label="Realized P&L" value={money(totals.realized)} />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(180px,1fr)_auto_auto]">
          <input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="Filter symbol" className="rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm outline-none ring-cyan-400/40 focus:ring" />
          <label className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm text-slate-300"><input type="checkbox" checked={openOnly} onChange={(event) => setOpenOnly(event.target.checked)} className="h-4 w-4 accent-cyan-400" />Open only</label>
          <button onClick={() => void load()} disabled={loading} className="rounded-xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh now'}</button>
        </div>
        <p className="mt-3 text-xs text-slate-500">Last updated: {lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString() : '—'}</p>
      </div>

      {error && <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
      {loading ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-10 text-center text-sm text-slate-500">Loading positions…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-10 text-center text-sm text-slate-500">No positions match the selected filters.</div>
      ) : (
        <div className="space-y-4">
          {filtered.map((position) => {
            const expanded = expandedId === position.id;
            const currentPrice = prices[position.symbol] ?? Number(position.averageEntryPrice);
            const openIndependent = position.subPositions.filter((subPosition) => subPosition.status === 'OPEN');
            const independentQuantity = openIndependent.reduce((sum, subPosition) => sum + Number(subPosition.quantity), 0);
            const independentCost = openIndependent.reduce((sum, subPosition) => sum + Number(subPosition.costQuote), 0);
            const basketQuantity = Number(position.totalQuantity) + independentQuantity;
            const basketCost = Number(position.totalCostQuote) + independentCost;
            const currentValue = currentPrice * basketQuantity;
            const unrealized = position.status === 'OPEN' ? currentValue - basketCost : 0;
            const realized = Number(position.realizedPnlQuote);
            const total = unrealized + realized;
            const hasPendingOrder = position.orders.some((order) => order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED');
            return (
              <article id={`position-${position.id}`} key={`${position.source}-${position.id}`} className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]">
                <div className="grid gap-4 p-5 xl:grid-cols-[1.2fr_0.9fr_0.9fr_0.9fr_auto] xl:items-center">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-lg font-semibold">{position.symbol}</h4>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${position.source === 'PAPER' ? 'bg-violet-400/15 text-violet-300' : 'bg-cyan-400/15 text-cyan-300'}`}>{position.source === 'PAPER' ? 'Paper' : 'Binance Testnet'}</span>
                      <span className="rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs text-emerald-300">{position.status}</span>
                      {position.recoveryMode && <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-xs font-semibold text-amber-300">RECOVERY</span>}
                    </div>
                    <p className="mt-2 text-sm text-slate-400">{position.strategyName}</p>
                    <p className="mt-1 text-xs text-slate-600">Opened {new Date(position.openedAt).toLocaleString()}</p>
                  </div>
                  <Metric label="Current price" value={number(currentPrice)} />
                  <Metric label="Unrealized P&L" value={money(unrealized)} />
                  <Metric label="Total P&L" value={money(total)} />
                  <button onClick={() => setExpandedId(expanded ? null : position.id)} className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-200">{expanded ? 'Hide details' : 'View details'}</button>
                </div>
                {expanded && (
                  <div className="border-t border-white/10 p-5">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <Metric label="Average entry" value={number(position.averageEntryPrice)} />
                      <Metric label="Basket quantity" value={number(basketQuantity)} />
                      <Metric label="Current value" value={money(currentValue)} />
                      <Metric label="Basket cost" value={money(basketCost)} />
                      <Metric label="Next DCA" value={position.nextDcaPrice ? number(position.nextDcaPrice) : '—'} />
                      <Metric label="Take profit" value={position.takeProfitPrice ? number(position.takeProfitPrice) : '—'} />
                      <Metric label="Recovery orders" value={position.recoveryMode ? String(position.recoveryDcaCount) : '—'} />
                      <Metric label="Recovery global TP" value={position.recoveryTakeProfitPrice ? number(position.recoveryTakeProfitPrice) : '—'} />
                      <Metric label="Recovery anchor" value={position.recoveryAnchorPrice ? number(position.recoveryAnchorPrice) : '—'} />
                      <Metric label="Realized P&L" value={money(realized)} />
                      <Metric label="Strategy state" value={position.strategyStatus ?? 'STOPPED'} />
                    </div>

                    <div className="mt-5 rounded-2xl border border-white/10 bg-slate-950/30 p-4">
                      <h5 className="text-sm font-semibold">Manual controls</h5>
                      <p className="mt-2 text-xs leading-5 text-slate-500">Pause and stop affect future bot actions only. Closing a position is a separate confirmed action.</p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button disabled={busyId === position.id || position.strategyStatus === 'PAUSED'} onClick={() => void changeStatus(position, 'PAUSED')} className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-200 disabled:opacity-40">Pause bot</button>
                        <button disabled={busyId === position.id || position.strategyStatus === 'RUNNING'} onClick={() => void changeStatus(position, 'RUNNING')} className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-40">Resume bot</button>
                        <button disabled={busyId === position.id || position.strategyStatus === 'STOPPED'} onClick={() => void changeStatus(position, 'STOPPED')} className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-sm font-semibold text-rose-200 disabled:opacity-40">Stop bot</button>
                        {position.source === 'PAPER' && position.status === 'OPEN' && <button disabled={busyId === position.id} onClick={() => void closePaper(position)} className="rounded-xl bg-rose-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40">Close Paper position</button>}
                        {position.source === 'TESTNET' && position.status === 'OPEN' && <button disabled={busyId === position.id || position.strategyStatus !== 'PAUSED' || hasPendingOrder} onClick={() => void closeTestnet(position)} className="rounded-xl bg-rose-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40">Close Testnet parent</button>}
                        {position.source === 'TESTNET' && <button disabled={busyId === position.id} onClick={() => void syncTestnet(position)} className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-40">Sync pending orders</button>}
                      </div>
                      {position.source === 'TESTNET' && position.strategyStatus !== 'PAUSED' && <p className="mt-3 text-xs text-amber-200">Pause the bot before submitting a manual Testnet close.</p>}
                      {position.source === 'TESTNET' && hasPendingOrder && <p className="mt-3 text-xs text-amber-200">A Testnet order is pending or partially filled. Sync it before closing.</p>}
                    </div>

                    <div className="mt-5">
                      <h5 className="text-sm font-semibold">Independent sub-positions</h5>
                      {position.subPositions.length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-slate-500">No independent levels have been opened.</p> : (
                        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[860px] text-left text-sm"><thead className="text-xs uppercase tracking-wider text-slate-500"><tr><th className="pb-3">Level</th><th className="pb-3">Status</th><th className="pb-3">Quantity</th><th className="pb-3">Cost</th><th className="pb-3">Entry</th><th className="pb-3">TP</th><th className="pb-3">P&L</th><th className="pb-3">Control</th></tr></thead><tbody>{position.subPositions.map((sub) => <tr key={sub.id} className="border-t border-white/10"><td className="py-3">#{sub.level}</td><td className="py-3">{sub.status}</td><td className="py-3">{number(sub.quantity)}</td><td className="py-3">{money(sub.costQuote)}</td><td className="py-3">{number(sub.entryPrice)}</td><td className="py-3">{number(sub.takeProfitPrice)}</td><td className="py-3">{money(sub.realizedPnlQuote)}</td><td className="py-3">{position.source === 'TESTNET' && sub.status === 'OPEN' ? <button disabled={busyId === sub.id || position.strategyStatus !== 'PAUSED' || hasPendingOrder} onClick={() => void closeTestnet(position, sub.id)} className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-200 disabled:opacity-40">Close leg</button> : '—'}</td></tr>)}</tbody></table></div>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/10 bg-slate-950/30 p-4"><p className="text-xs uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 font-semibold">{value}</p></div>;
}
