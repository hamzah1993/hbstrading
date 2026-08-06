import { useEffect, useMemo, useState } from 'react';
import { api, type CreateStrategyPayload, type TestnetOrderPreview, type TradingStrategy } from '../lib/api';

type Props = {
  token: string;
  defaultMode?: BotMode;
  onClose: () => void;
  onCreated: (strategy: TradingStrategy) => void;
};

type BotMode = 'PAPER' | 'TESTNET';
type Balance = { asset: string; free: number; locked: number };

const initialForm: CreateStrategyPayload & { marketPrice: number; mode: BotMode } = {
  name: 'Testnet DCA Bot', symbol: '', environment: 'TESTNET', paperTrading: false,
  riskBudgetQuote: 1000, baseOrderQuote: 100, maxDcaOrders: 5, dcaStepPercent: 2,
  dcaMultiplier: 1.5, takeProfitPercent: 1.5, independentFromLevel: 5,
  recoveryEnabled: true, recoveryMaxOrders: 5, recoveryStepPercents: [5, 8, 12, 18, 25],
  recoveryMultipliers: [1, 1.5, 2, 3, 5], recoveryTakeProfitPercent: 1.5,
  marketPrice: 0, mode: 'TESTNET',
};

const quoteAssets = ['USDT', 'USDC', 'BUSD', 'FDUSD'];
const splitPair = (symbol: string) => {
  const quoteAsset = quoteAssets.find((asset) => symbol.endsWith(asset)) ?? 'USDT';
  return { baseAsset: symbol.slice(0, -quoteAsset.length), quoteAsset };
};

export function CreateBotWizard({ token, defaultMode = 'TESTNET', onClose, onCreated }: Props) {
  const [form, setForm] = useState(() => ({ ...initialForm, mode: defaultMode, paperTrading: defaultMode === 'PAPER', name: defaultMode === 'PAPER' ? 'Paper DCA Bot' : 'Testnet DCA Bot' }));
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [loadingBalances, setLoadingBalances] = useState(true);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [preview, setPreview] = useState<TestnetOrderPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [existingNames, setExistingNames] = useState<string[]>([]);

  const estimatedLevels = form.maxDcaOrders + 1;
  const estimatedInitialQuantity = form.marketPrice > 0 ? form.baseOrderQuote / form.marketPrice : 0;
  const duplicateName = useMemo(() => {
    const normalized = form.name.trim().toLowerCase();
    return normalized.length > 0 && existingNames.some((name) => name.trim().toLowerCase() === normalized);
  }, [existingNames, form.name]);
  const pair = useMemo(() => splitPair(form.symbol), [form.symbol]);
  const balanceMap = useMemo(() => new Map(balances.map((balance) => [balance.asset, balance])), [balances]);
  const baseBalance = balanceMap.get(pair.baseAsset)?.free ?? 0;
  const quoteBalance = balanceMap.get(pair.quoteAsset)?.free ?? 0;
  const plannedDcaExposure = useMemo(() => {
    let total = form.baseOrderQuote;
    for (let index = 1; index <= form.maxDcaOrders; index += 1) total += form.baseOrderQuote * Math.pow(form.dcaMultiplier, index);
    return Math.min(total, form.riskBudgetQuote);
  }, [form.baseOrderQuote, form.dcaMultiplier, form.maxDcaOrders, form.riskBudgetQuote]);
  const remainingRiskBudget = Math.max(form.riskBudgetQuote - form.baseOrderQuote, 0);
  const recoveryReserve = Math.max(form.riskBudgetQuote - plannedDcaExposure, 0);

  useEffect(() => {
    let cancelled = false;
    api.listStrategies(token).then((items) => { if (!cancelled) setExistingNames(items.map((item) => item.name)); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [token]);

  async function refreshBalances() {
    setLoadingBalances(true);
    try {
      const result = await api.getBinanceTestnetBalances(token);
      const nextBalances = result.balances.map((balance) => ({ ...balance, asset: balance.asset.toUpperCase() }));
      setBalances(nextBalances);
      const symbols = nextBalances
        .filter((balance) => !quoteAssets.includes(balance.asset))
        .map((balance) => `${balance.asset}USDT`)
        .filter((symbol, index, all) => all.indexOf(symbol) === index)
        .sort();
      setAvailableSymbols(symbols);
      setForm((current) => ({ ...current, symbol: current.symbol || symbols[0] || 'BTCUSDT' }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load Binance Testnet balances');
    } finally {
      setLoadingBalances(false);
    }
  }

  useEffect(() => { void refreshBalances(); }, [token]);

  useEffect(() => {
    if (!form.symbol) return;
    let cancelled = false;
    setLoadingPrice(true); setPreview(null); setError(null);
    api.getMarketCandles(token, form.symbol, '1m', 2, 'testnet')
      .then((result) => {
        const latest = result.candles[result.candles.length - 1];
        if (!cancelled && latest?.close && Number.isFinite(latest.close)) setForm((current) => ({ ...current, marketPrice: latest.close }));
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load current market price'); })
      .finally(() => { if (!cancelled) setLoadingPrice(false); });
    return () => { cancelled = true; };
  }, [token, form.symbol]);

  useEffect(() => { setPreview(null); }, [form.mode, form.symbol, form.baseOrderQuote]);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) { setForm((current) => ({ ...current, [key]: value })); }

  async function loadPreview() {
    if (form.mode !== 'TESTNET') return;
    setPreviewing(true); setError(null);
    try {
      await refreshBalances();
      const result = await api.previewTestnetOrder(token, { symbol: form.symbol, quoteAmount: form.baseOrderQuote });
      setPreview(result); setForm((current) => ({ ...current, marketPrice: result.marketPrice }));
    } catch (reason) {
      setPreview(null); setError(reason instanceof Error ? reason.message : 'Unable to validate Testnet order');
    } finally { setPreviewing(false); }
  }

  async function goNext() {
    if (!form.name.trim()) return setError('Bot name is required.');
    if (duplicateName) return setError(`You already have a bot named “${form.name.trim()}”. Choose another name or edit the existing bot.`);
    if (form.riskBudgetQuote < form.baseOrderQuote) return setError('Risk budget must be at least the base order amount.');
    if (step === 2 && form.mode === 'TESTNET') {
      setPreviewing(true);
      try {
        const result = await api.previewTestnetOrder(token, { symbol: form.symbol, quoteAmount: form.baseOrderQuote });
        setPreview(result); setForm((current) => ({ ...current, marketPrice: result.marketPrice })); setStep(3);
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to validate Testnet order'); }
      finally { setPreviewing(false); }
      return;
    }
    setStep((current) => current + 1);
  }

  async function submit() {
    if (!form.name.trim()) return setError('Bot name is required.');
    if (duplicateName) return setError(`You already have a bot named “${form.name.trim()}”. Choose another name or edit the existing bot.`);
    if (!form.symbol || !form.marketPrice) return setError('A symbol and current market price are required.');
    if (form.riskBudgetQuote < form.baseOrderQuote) return setError('Risk budget must be at least the base order amount.');
    if (form.mode === 'TESTNET' && !preview) return setError('Refresh and confirm the Binance Testnet order preview before creating the bot.');
    if (form.mode === 'TESTNET' && quoteBalance < Number(preview?.estimatedSpend ?? form.baseOrderQuote)) return setError(`Insufficient ${pair.quoteAsset} balance for the initial order.`);

    setSubmitting(true); setError(null);
    let strategy: TradingStrategy | null = null;
    try {
      if (form.mode === 'TESTNET') {
        const latestPreview = await api.previewTestnetOrder(token, { symbol: form.symbol, quoteAmount: form.baseOrderQuote });
        setPreview(latestPreview);
      }
      const { marketPrice, mode, ...payload } = form;
      strategy = await api.createStrategy(token, { ...payload, name: payload.name.trim(), environment: 'TESTNET', paperTrading: mode === 'PAPER' });
      if (mode === 'PAPER') await api.openPaperPosition(token, strategy.id, marketPrice);
      else {
        await api.setStrategyStatus(token, strategy.id, 'PAUSED');
        const confirmed = await api.previewTestnetOrder(token, { symbol: form.symbol, quoteAmount: form.baseOrderQuote });
        await api.executeTestnetOrder(token, strategy.id, { side: 'BUY', quantity: Number(confirmed.normalizedQuantity) });
      }
      onCreated(strategy);
    } catch (reason) {
      if (strategy && form.mode === 'TESTNET') await api.deleteStrategy(token, strategy.id).catch(() => undefined);
      setError(reason instanceof Error ? reason.message : 'Unable to create bot');
    } finally { setSubmitting(false); }
  }

  const metric = (label: string, value: string) => <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 break-all font-medium">{value}</p></div>;

  return <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 p-2 backdrop-blur-sm sm:p-4"><div className="flex min-h-full items-start justify-center py-2 sm:items-center sm:py-6"><div className="flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0a1728] shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
    <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-4 sm:px-6"><div><p className="text-xs uppercase tracking-[0.28em] text-cyan-300">Create bot</p><h2 className="mt-1 text-xl font-semibold">{form.mode === 'PAPER' ? 'Paper strategy setup' : 'Binance Testnet setup'}</h2></div><button onClick={onClose} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-slate-300">Close</button></div>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mb-5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">Environment: <strong>{form.mode === 'PAPER' ? 'Paper' : 'Binance Testnet'}</strong>. Change it from the global header before opening Create Bot.</div>
      <div className="mb-6 grid grid-cols-3 gap-2 text-xs">{['Basics', 'Risk & DCA', 'Review'].map((label, index) => <div key={label} className={`rounded-xl px-2 py-2 text-center ${step === index + 1 ? 'bg-cyan-400 text-slate-950' : 'bg-white/[0.04] text-slate-400'}`}>{index + 1}. {label}</div>)}</div>
      {error && <div className="mb-5 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
      {step === 1 && <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-slate-300">Bot name<input value={form.name} onChange={(event) => update('name', event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3" />{duplicateName && <span className="mt-1 block text-xs text-rose-300">A bot with this name already exists.</span>}</label>
        <label className="text-sm text-slate-300">Symbol pair<select disabled={loadingBalances} value={form.symbol} onChange={(event) => update('symbol', event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-[#101f32] px-4 py-3">{availableSymbols.map((symbol) => <option key={symbol}>{symbol}</option>)}</select></label>
        <label className="text-sm text-slate-300 sm:col-span-2">Entry price<input type="number" min="0" step="any" value={form.marketPrice || ''} placeholder={loadingPrice ? 'Loading…' : 'Current market price'} onChange={(event) => update('marketPrice', Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3" /></label>
        {form.mode === 'TESTNET' && <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">{metric(`Available ${pair.baseAsset}`, baseBalance.toLocaleString(undefined, { maximumFractionDigits: 8 }))}{metric(`Available ${pair.quoteAsset}`, quoteBalance.toLocaleString(undefined, { maximumFractionDigits: 8 }))}<button type="button" onClick={() => void refreshBalances()} className="sm:col-span-2 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-200">Refresh balances</button></div>}
      </div>}
      {step === 2 && <div className="grid gap-4 sm:grid-cols-2">{[
        ['riskBudgetQuote','Risk budget (USDT)'],['baseOrderQuote','Base order (USDT)'],['maxDcaOrders','Maximum DCA orders'],['dcaStepPercent','DCA step (%)'],['dcaMultiplier','DCA multiplier'],['takeProfitPercent','Take profit (%)'],['independentFromLevel','Independent from level'],
      ].map(([key,label]) => <label key={key} className="text-sm text-slate-300">{label}<input type="number" min="0" step="any" value={form[key as keyof typeof form] as number} onChange={(event) => update(key as keyof typeof form, Number(event.target.value) as never)} className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3" /></label>)}
        <div className="sm:col-span-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4"><label className="flex items-center gap-3 text-sm text-slate-200"><input type="checkbox" checked={form.recoveryEnabled} onChange={(event) => update('recoveryEnabled', event.target.checked)} className="h-4 w-4 accent-amber-400" />Enable Dynamic DCA Recovery</label><p className="mt-2 text-xs leading-5 text-slate-400">After the first independent level, Recovery can add deeper basket buys at {form.recoveryStepPercents.join('/')}% using {form.recoveryMultipliers.join('/')}× sizing, then close the basket at one weighted global TP.</p></div>
        {form.recoveryEnabled && <><label className="text-sm text-slate-300">Recovery max orders<input type="number" min="0" max="5" step="1" value={form.recoveryMaxOrders} onChange={(event) => update('recoveryMaxOrders', Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3" /></label><label className="text-sm text-slate-300">Recovery global TP (%)<input type="number" min="0.01" step="any" value={form.recoveryTakeProfitPercent} onChange={(event) => update('recoveryTakeProfitPercent', Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3" /></label></>}
        <div className="sm:col-span-2 grid gap-3 sm:grid-cols-4">{metric('Planned maximum exposure', `$${plannedDcaExposure.toLocaleString(undefined,{maximumFractionDigits:2})}`)}{metric('Recovery reserve', `$${recoveryReserve.toLocaleString(undefined,{maximumFractionDigits:2})}`)}{metric('Remaining risk after entry', `$${remainingRiskBudget.toLocaleString(undefined,{maximumFractionDigits:2})}`)}{metric('Configured levels', String(estimatedLevels))}</div>
        {form.recoveryEnabled && recoveryReserve <= 0 && <p className="sm:col-span-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-5 text-amber-200">Your normal DCA plan can consume the full risk budget. Recovery orders will still respect the hard cap, but they can only buy if earlier independent exposure has been closed or you increase the risk budget.</p>}
      </div>}
      {step === 3 && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2">{metric('Mode', form.mode === 'PAPER' ? 'Paper' : 'Binance Testnet')}{metric('Strategy', form.name)}{metric('Symbol', form.symbol)}{metric('Market price', `$${(preview?.marketPrice ?? form.marketPrice).toLocaleString()}`)}{metric('Risk budget', `$${form.riskBudgetQuote}`)}{metric('Planned exposure', `$${plannedDcaExposure.toLocaleString(undefined,{maximumFractionDigits:2})}`)}{metric('Independent from', `Level #${form.independentFromLevel}`)}{metric('Recovery', form.recoveryEnabled ? `${form.recoveryMaxOrders} orders · ${form.recoveryTakeProfitPercent}% global TP` : 'Disabled')}{metric('Initial quantity', form.mode === 'TESTNET' ? preview?.normalizedQuantity ?? 'Preview required' : estimatedInitialQuantity.toPrecision(8))}{metric(`Available ${pair.baseAsset}`, baseBalance.toLocaleString(undefined,{maximumFractionDigits:8}))}{metric(`Available ${pair.quoteAsset}`, (preview?.availableQuote ?? quoteBalance).toLocaleString(undefined,{maximumFractionDigits:8}))}{metric(`Remaining ${pair.quoteAsset}`, (preview?.remainingQuote ?? quoteBalance - form.baseOrderQuote).toLocaleString(undefined,{maximumFractionDigits:8}))}</div>
        {form.mode === 'TESTNET' && <button type="button" onClick={() => void loadPreview()} disabled={previewing} className="w-full rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-sm font-semibold text-cyan-200">{previewing ? 'Validating…' : 'Refresh balances and order preview'}</button>}
      </div>}
    </div>
    <div className="shrink-0 border-t border-white/10 px-4 py-4 sm:px-6"><div className="flex justify-between gap-3"><button disabled={step === 1 || submitting} onClick={() => setStep((current) => current - 1)} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm disabled:opacity-40">Back</button>{step < 3 ? <button disabled={previewing || duplicateName || !form.name.trim() || !form.symbol || !form.marketPrice} onClick={() => void goNext()} className="rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-50">Continue</button> : <button disabled={submitting || duplicateName || !preview && form.mode === 'TESTNET'} onClick={() => void submit()} className="rounded-xl bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-50">{submitting ? 'Creating…' : form.mode === 'PAPER' ? 'Create paper bot' : 'Confirm Testnet bot & buy'}</button>}</div></div>
  </div></div></div>;
}
