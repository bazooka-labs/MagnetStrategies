"use client";

// The Perps purchase card.
//
// Deliberately not a trading terminal. Market, direction, amount, risk, a target
// to take profit at — then sign once. Everything the card shows is solved from
// live chain state and the signed oracle payload for THAT market; nothing is
// cached and no number is shared between markets.
//
// Read-only for now: it quotes and shows what would happen. Wallet signing is
// wired separately so the numbers can be checked against chain before anything
// can be sent.

import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Info, TriangleAlert } from "lucide-react";
import { Panel } from "@/components/magnetfi/v2/shared";
import {
  ACTIVE_MARKET_ID,
  BUILDER_ADDRESS,
  COLLATERAL_ASSET_ID,
  DEFAULT_SLIPPAGE_BPS,
  ENABLED_MARKET_IDS,
  PEX_MARKETS,
  POSITION_BUILDER_FEE_BPS,
  PROTECTION_ENABLED,
} from "@/lib/perps";
import { solveBar, type Side } from "@/lib/perpsSolver";
import { price12ToUsd, usdToPrice12 } from "@/lib/perpsOracle";
import {
  maxPayoffUsd,
  payoffAtPrice,
  priceForPayoff,
  quoteOpen,
  takeProfitBounds,
  type OpenQuote,
} from "@/lib/perpsQuote";
import { oracleAgeSeconds, usePerpsMarket } from "@/hooks/usePerpsMarket";

const MARKETS = Object.values(PEX_MARKETS).filter((m) => ENABLED_MARKET_IDS.includes(m.id));

/** Prices span $0.10 and $83,000, so precision has to follow the magnitude. */
const fmtPrice = (p: number) =>
  p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  : p >= 1 ? `$${p.toFixed(2)}`
  : `$${p.toFixed(6)}`;
const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function PerpsCard() {
  const [marketId, setMarketId] = useState<number>(ACTIVE_MARKET_ID);
  const [side, setSide] = useState<Side>("long");
  const [amount, setAmount] = useState<string>("100");
  const [barPos, setBarPos] = useState<number>(0.5);
  const [tpPrice, setTpPrice] = useState<string>("");
  const [tpTouched, setTpTouched] = useState(false);

  const { data, loading, error } = usePerpsMarket(marketId);
  const market = MARKETS.find((m) => m.id === marketId)!;
  const collateralUsd = Math.max(0, Number(amount) || 0);
  const indexUsd = data ? price12ToUsd(data.oracle.indexPrice12) : null;

  // Both ends of the bar are solved live; neither is a constant.
  const bar = useMemo(() => {
    if (!data || collateralUsd <= 0) return null;
    const d = data.oracle.decoded;
    return solveBar(data.state, side, collateralUsd, data.oracle.indexPrice12, {
      prices: {
        indexPrice12: data.oracle.indexPrice12,
        longPrice12: (d.longMinPrice + d.longMaxPrice) / BigInt(2),
        shortPrice12: (d.shortMinPrice + d.shortMaxPrice) / BigInt(2),
      },
    });
  }, [data, side, collateralUsd]);

  const notional = useMemo(() => {
    if (!bar?.open) return 0;
    return bar.minNotionalUsd + (bar.maxNotionalUsd - bar.minNotionalUsd) * barPos;
  }, [bar, barPos]);

  const quote: OpenQuote | null = useMemo(() => {
    if (!data || !bar?.open || notional <= 0) return null;
    try {
      return quoteOpen({
        state: data.state, oracle: data.oracle, side,
        collateralUsd, notionalUsd: notional,
        builderAddress: BUILDER_ADDRESS || "A".repeat(58),
        collateralAssetId: COLLATERAL_ASSET_ID,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
    } catch { return null; }
  }, [data, bar, notional, side, collateralUsd]);

  // Default the target to a round +50% on the stake, but never fight the user.
  useEffect(() => {
    if (tpTouched || !quote?.ok) return;
    const p = priceForPayoff(quote, collateralUsd * 0.5);
    if (p) setTpPrice(price12ToUsd(p).toFixed(indexUsd && indexUsd >= 1000 ? 0 : 6));
  }, [quote, collateralUsd, tpTouched, indexUsd]);

  // String -> Price12 exactly; a BTC price times 1e12 overflows Number precision.
  const tp12 = usdToPrice12(tpPrice) ?? BigInt(0);
  const bounds = quote?.ok ? takeProfitBounds(quote) : null;
  const tpValid = !!(quote?.ok && bounds && tp12 >= bounds.minPrice12 &&
    (bounds.maxPrice12 === null || tp12 <= bounds.maxPrice12));
  const tpPayoff = quote?.ok && tpValid ? payoffAtPrice(quote, tp12) : null;
  const maxPayoff = quote?.ok ? maxPayoffUsd(quote) : null;
  const age = oracleAgeSeconds(data);

  return (
    <Panel className="p-5 sm:p-6">
      {/* Market */}
      <div className="flex items-center gap-2">
        {MARKETS.map((m) => {
          const on = m.id === marketId;
          return (
            <button key={m.id} onClick={() => setMarketId(m.id)}
              className={`flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                on ? "border-magnet-400/60 bg-magnet-500/10" : "border-white/10 bg-white/[0.02] hover:border-white/20"}`}>
              <div className={`text-sm font-semibold ${on ? "text-white" : "text-white/70"}`}>{m.label}</div>
              <div className="text-xs tabular-nums text-white/50">
                {on && indexUsd !== null ? fmtPrice(indexUsd) : on && loading ? "…" : " "}
              </div>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Live market data unavailable — trading is disabled until it returns. ({error})</span>
        </div>
      )}

      {/* Direction */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {(["long", "short"] as Side[]).map((s) => {
          const on = s === side;
          const up = s === "long";
          return (
            <button key={s} onClick={() => { setSide(s); setTpTouched(false); }}
              className={`flex items-center justify-center gap-2 rounded-xl border py-3 text-sm font-semibold transition-colors ${
                on && up ? "border-green-400/50 bg-green-500/15 text-green-300"
                : on ? "border-red-400/50 bg-red-500/15 text-red-300"
                : "border-white/10 bg-white/[0.02] text-white/60 hover:border-white/20"}`}>
              {up ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
              {up ? "Long" : "Short"}
            </button>
          );
        })}
      </div>

      {/* Amount */}
      <label className="mt-4 block">
        <span className="text-xs font-medium uppercase tracking-wide text-white/50">Amount</span>
        <div className="mt-1.5 flex items-center rounded-xl border border-white/10 bg-black/40 px-3">
          <span className="text-white/40">$</span>
          <input id="perps-amount" inputMode="decimal" value={amount}
            onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setTpTouched(false); }}
            className="w-full bg-transparent px-2 py-3 text-lg font-semibold tabular-nums text-white outline-none" />
          <span className="text-xs text-white/40">USDC</span>
        </div>
      </label>

      {/* Risk */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-white/50">Risk</span>
          <span className="text-sm font-semibold tabular-nums text-white">
            {bar?.open && quote?.ok ? `${quote.leverage.toFixed(2)}×` : "—"}
          </span>
        </div>
        <input id="perps-risk" type="range" min={0} max={1} step={0.01} value={barPos}
          disabled={!bar?.open}
          onChange={(e) => { setBarPos(Number(e.target.value)); setTpTouched(false); }}
          className="mt-2 w-full accent-magnet-400 disabled:opacity-30" />
        <div className="flex justify-between text-[11px] tabular-nums text-white/40">
          <span>{bar?.open ? `${bar.minLeverage.toFixed(2)}×` : ""}</span>
          <span>{bar?.open ? `${bar.maxLeverage.toFixed(2)}×` : ""}</span>
        </div>
        {bar && !bar.open && (
          <p className="mt-1 text-xs text-amber-300/90">{bar.closedReason}</p>
        )}
        {bar?.open && (
          <p className="mt-1 text-[11px] text-white/35">
            Position size {fmtUsd(notional)} · limited by {bar.binding.replace(/_/g, " ")}
          </p>
        )}
      </div>

      {/* Liquidation — permanent, not a disclosure the user can dismiss */}
      <div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/[0.07] px-3.5 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-red-300/80">Liquidation</span>
          <span className="text-base font-bold tabular-nums text-red-300">
            {quote?.ok ? fmtPrice(price12ToUsd(quote.liquidationPrice12)) : "—"}
          </span>
        </div>
        {quote?.ok && indexUsd !== null && (
          <p className="mt-0.5 text-[11px] text-red-200/60">
            {side === "long" ? "Falls to" : "Rises to"} this and the position closes at a total loss of {fmtUsd(collateralUsd)}
            {" · "}{(Math.abs(price12ToUsd(quote.liquidationPrice12) - indexUsd) / indexUsd * 100).toFixed(1)}% away
          </p>
        )}
      </div>

      {/* Take profit — mandatory */}
      <label className="mt-4 block">
        <span className="text-xs font-medium uppercase tracking-wide text-white/50">
          Take profit at {market.label.split("/")[0]} price
        </span>
        <div className="mt-1.5 flex items-center rounded-xl border border-white/10 bg-black/40 px-3">
          <span className="text-white/40">$</span>
          <input id="perps-tp" inputMode="decimal" value={tpPrice}
            onChange={(e) => { setTpPrice(e.target.value.replace(/[^0-9.]/g, "")); setTpTouched(true); }}
            className="w-full bg-transparent px-2 py-3 font-semibold tabular-nums text-white outline-none" />
        </div>
        {quote?.ok && (
          tpValid && tpPayoff !== null ? (
            <p className="mt-1 text-xs text-green-300/90">
              Closes for {fmtUsd(tpPayoff)} profit before costs
            </p>
          ) : (
            <p className="mt-1 text-xs text-amber-300/90">
              {side === "short" && maxPayoff !== null && Number.isFinite(maxPayoff)
                ? `A short can make at most ${fmtUsd(maxPayoff)} — its price can only fall to zero. Choose a target below ${fmtPrice(price12ToUsd(quote.entryPrice12))}.`
                : `Choose a target above ${fmtPrice(price12ToUsd(quote.entryPrice12))}.`}
            </p>
          )
        )}
      </label>

      {/* Protection */}
      {!PROTECTION_ENABLED && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-medium text-white/60">Protection</span> — an optional stop below
            liquidation — is not enabled yet. Until it is, liquidation is the only floor.
          </span>
        </div>
      )}

      {/* Costs */}
      {quote?.ok && (
        <dl className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-xs">
          {[
            ["Entry price", fmtPrice(price12ToUsd(quote.entryPrice12))],
            ["PEX fee", fmtUsd(quote.openFeeUsd)],
            [`Magnet fee (${POSITION_BUILDER_FEE_BPS} bps, charged again on close)`, fmtUsd(quote.builderFeeUsd)],
            ["Price impact", `${quote.impactUsd >= 0 ? "+" : "−"}${fmtUsd(Math.abs(quote.impactUsd))}`],
            ["Backing the position", fmtUsd(quote.netCollateralUsd)],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-white/45">{k}</dt>
              <dd className="tabular-nums text-white/75">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <button disabled
        className="mt-5 w-full rounded-xl bg-magnet-500/20 py-3.5 text-sm font-semibold text-white/40 cursor-not-allowed">
        Connect wallet to trade — coming next
      </button>

      <p className="mt-2.5 text-center text-[10px] leading-relaxed text-white/30">
        Trades execute on <span className="text-white/45">PEX</span>, a third-party protocol by Ultrade.
        Magnet Strategies holds no funds and operates no exchange. PEX has had no external audit.
        {age !== null && <> · Price signed {age}s ago</>}
      </p>
    </Panel>
  );
}
