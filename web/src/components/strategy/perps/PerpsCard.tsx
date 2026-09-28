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
import algosdk from "algosdk";
import { ArrowDownRight, ArrowUpRight, Info, TriangleAlert } from "lucide-react";
import { Panel } from "@/components/magnetfi/v2/shared";
import {
  ACTIVE_MARKET_ID,
  BUILDER_ADDRESS,
  COLLATERAL_ASSET_ID,
  CHILD_KEEPER_FEE_USDC,
  DEFAULT_SLIPPAGE_BPS,
  ENABLED_MARKET_IDS,
  MAX_TAKE_PROFIT_MULTIPLE,
  PEX_MARKETS,
  POSITION_BUILDER_FEE_BPS,
  PROTECTION_ENABLED,
} from "@/lib/perps";
import { solveBar, type Side } from "@/lib/perpsSolver";
import { price12ToUsd, usdToPrice12 } from "@/lib/perpsOracle";
import {
  confirmCeiling,
  payoffAtPrice,
  priceForPayoff,
  quoteOpen,
  displayTakeProfitBounds,
  formatPriceUsd,
  priceDisplayDecimals,
  type OpenQuote,
} from "@/lib/perpsQuote";
import { oracleAgeSeconds, usePerpsMarket } from "@/hooks/usePerpsMarket";
import { usePerpsPreflight } from "@/hooks/usePerpsPreflight";
import { useWallet } from "@/hooks/useWallet";
import { ALGOD_URLS } from "@/lib/constants";
import {
  openPosition,
  PositionAlreadyOpenError,
  type OpenStage,
  type OpenPositionResult,
} from "@/lib/perpsClient";
import { parseMoney, readNumericInput } from "@/lib/perpsInput";

const MARKETS = Object.values(PEX_MARKETS).filter((m) => ENABLED_MARKET_IDS.includes(m.id));

/** Prices span $0.10 and $83,000, so precision has to follow the magnitude. */
// Formatting comes from perpsQuote, which is also where the take-profit bounds
// are rounded for display. One rule, one place: the card having its own copy is
// how a printed bound came to be a number the card then refused.
const fmtPrice = formatPriceUsd;
const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;


/**
 * `value`, but only after it has stopped changing for `ms`.
 *
 * Deliberately returns the CURRENT value on first render rather than null, so
 * nothing flickers through an empty state on mount.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

export function PerpsCard() {
  const [marketId, setMarketId] = useState<number>(ACTIVE_MARKET_ID);
  const [side, setSide] = useState<Side>("long");
  const [amount, setAmount] = useState<string>("100");
  const [barPos, setBarPos] = useState<number>(0.5);
  const [tpPrice, setTpPrice] = useState<string>("");
  const [tpTouched, setTpTouched] = useState(false);
  /**
   * Why the last keystroke was refused, per field.
   *
   * Refusals used to be a silent `return`, which is safe but leaves a user
   * on a comma keypad pressing the only decimal key they have and watching
   * nothing happen. Saying why is the difference between a guard and a
   * broken field.
   */
  const [amountHint, setAmountHint] = useState<string | null>(null);
  const [tpHint, setTpHint] = useState<string | null>(null);

  const { data, loading, error, attemptAt } = usePerpsMarket(marketId);
  const preflight = usePerpsPreflight();
  const wallet = useWallet();

  /** Submission state. `null` means idle. */
  const [stage, setStage] = useState<OpenStage | null>(null);
  const [result, setResult] = useState<OpenPositionResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const market = MARKETS.find((m) => m.id === marketId)!;
  /**
   * The amount the solver sees, settled.
   *
   * `amount` drives the input and updates on every keystroke; this drives
   * `solveBar`, `confirmCeiling` and `quoteOpen`. Wiring the solver straight to
   * the raw string cost roughly 28 synchronous quote evaluations per keystroke
   * — `confirmCeiling` alone walks up to twelve — so typing "100" ran it three
   * times over. Nothing there is worth computing for a number the user is still
   * in the middle of typing.
   *
   * Only the derived numbers wait; the field itself never does.
   */
  const settledAmount = useDebounced(amount, 120);
  const collateralUsd = parseMoney(settledAmount) ?? 0;
  /**
   * The field and the figures agree.
   *
   * For the debounce window plus the render that follows it, the input shows
   * one amount while the liquidation price, the size, the leverage, the costs
   * and the take-profit all still describe the previous one. The dangerous
   * direction is downward — field reads "5" while everything else, and
   * everything the write path would receive, still says "100".
   *
   * This is the one place on the card where a number on screen and the number
   * that would be signed are allowed to disagree, so trading is gated on it.
   */
  const amountSettled = amount === settledAmount;
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

  /**
   * The bar's right end must be a size the chain will actually accept.
   *
   * The solved ceiling is correct but exact: converting it to micro-units rounds
   * up by a unit or two and the quote returns initial_margin_breach. Offering it
   * raw produces a bar whose top rejects — which is worse than a slightly lower
   * top, because the user only finds out after the wallet prompt. confirmCeiling
   * steps down until a real quote passes. It is local, not a network call, so
   * this is cheap enough to run on every change.
   */
  const confirmed = useMemo(() => {
    if (!data || !bar?.open) return null;
    try {
      return confirmCeiling({
        state: data.state, oracle: data.oracle, side, collateralUsd,
        builderAddress: BUILDER_ADDRESS || "A".repeat(58),
        collateralAssetId: COLLATERAL_ASSET_ID,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
    } catch { return null; }
  }, [data, bar, side, collateralUsd]);

  const ceilingUsd = confirmed?.notionalUsd ?? 0;

  /**
   * Trading is blocked whenever the data cannot be trusted, not merely
   * annotated.
   *
   * The banner used to claim "trading is disabled" while the slider stayed live
   * and every figure rendered from a snapshot the hook had already judged
   * unusable. `signatureVerified` was never read at all, though it exists
   * precisely so callers can refuse a price that could not be checked against
   * PEX's signing key.
   *
   * `preflight.canOpen` is null until the first check returns, and `=== true`
   * is deliberate: "not yet verified" has to read as "no". The alternative —
   * `!== false` — would let every trade through during the window the check
   * exists to cover.
   */
  const dataTrusted = !!data && !error && data.oracle.signatureVerified;
  const tradable = !!(
    dataTrusted && preflight.canOpen === true && amountSettled
    && bar?.open && confirmed && ceilingUsd >= bar.minNotionalUsd
  );

  const notional = useMemo(() => {
    if (!bar?.open || !tradable) return 0;
    return bar.minNotionalUsd + (ceilingUsd - bar.minNotionalUsd) * barPos;
  }, [bar, ceilingUsd, tradable, barPos]);

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
    // `priceForPayoff` returns null when the requested profit exceeds what the
    // position can pay — for a short that ceiling is its notional, and because
    // both markets are OI-capped well below typical collateral, +50% of stake
    // is unreachable across a wide band of ordinary inputs. Measured: on a
    // $1,000 ALGO short it was null at EVERY slider position.
    //
    // The old code did `if (!p) return`, which wrote nothing — leaving the one
    // mandatory field on the card empty on mount, or silently holding a target
    // solved for a different size after a slider move. Falling back to a fixed
    // move from entry keeps it populated and honest.
    const wanted = priceForPayoff(quote, collateralUsd * 0.5)
      ?? (side === "long"
        ? (quote.entryPrice12 * BigInt(110)) / BigInt(100)
        : (quote.entryPrice12 * BigInt(90)) / BigInt(100));
    // Clamp into the band the card enforces. At high leverage a +50%-of-stake
    // target is a small percentage move, which can land inside the crossing
    // guard — and a card that opens showing its own invalid default is worse
    // than one that opens showing a conservative one.
    const b = displayTakeProfitBounds(quote);
    const clamped = wanted < b.minPrice12 ? b.minPrice12
      : wanted > b.maxPrice12 ? b.maxPrice12 : wanted;
    setTpPrice(price12ToUsd(clamped).toFixed(priceDisplayDecimals(price12ToUsd(clamped))));
  }, [quote, collateralUsd, side, tpTouched]);

  // String -> Price12 exactly; a BTC price times 1e12 overflows Number precision.
  const tp12 = usdToPrice12(tpPrice) ?? BigInt(0);
  // Display bounds, not the true ones: each edge is rounded outward to the
  // precision it is printed at, so the number the card tells the user to use is
  // a number the card accepts. The write path re-checks against the true bounds,
  // which are looser, so nothing accepted here is refused there.
  const bounds = quote?.ok ? displayTakeProfitBounds(quote) : null;
  const tpValid = !!(quote?.ok && bounds
    && tp12 >= bounds.minPrice12 && tp12 <= bounds.maxPrice12);
  /**
   * Which edge was missed, so the message can name the real problem.
   *
   * The two edges mean different things now. One is the crossing guard — too
   * close to the current price, and PEX would execute the order on arrival —
   * and the other is the typo guard. Telling a user to "choose a target above
   * $X" when they are $X × 10 out, or vice versa, sends them the wrong way.
   */
  const tpTooNear = !!(quote?.ok && bounds && tp12 > BigInt(0)
    && (side === "long" ? tp12 < bounds.minPrice12 : tp12 > bounds.maxPrice12));
  const tpTypo = !!(quote?.ok && bounds && tp12 > BigInt(0)
    && (side === "long" ? tp12 > bounds.maxPrice12 : tp12 < bounds.minPrice12));
  const tpPayoff = quote?.ok && tpValid ? payoffAtPrice(quote, tp12) : null;
  /**
   * Whether a liquidation price exists at all.
   *
   * PEX signals "this position cannot be liquidated" by returning
   * `liquidation_price_estimate = 0` with an empty
   * `liquidation_price_direction`, which happens whenever notional is at or
   * below collateral. `liquidationDirection` was decoded and **never read
   * anywhere in the tree**, so the card rendered the zero as a price: the
   * permanent red box, the single most prominent disclosure on the screen,
   * read "Liquidation $0.000000 — falls to this and the position closes at a
   * total loss of $1,000.00". Both markets are OI-capped well below $1,000, so
   * anyone with that much collateral saw it at every slider position.
   */
  const liquidatable = !!(quote?.ok
    && quote.liquidationDirection !== "" && quote.liquidationPrice12 > BigInt(0));
  // attemptAt changes on every load attempt, so this re-renders and keeps
  // ageing even when a repeated identical error would otherwise freeze it.
  void attemptAt;
  const age = oracleAgeSeconds(data);

  const submitting = stage !== null;
  /**
   * Everything required to sign, all of it already true for `tradable`, plus a
   * connected wallet and a valid target.
   */
  const canSubmit = !!(
    tradable && tpValid && quote?.ok && !submitting
    && wallet.isConnected && wallet.address && notional > 0
  );

  /**
   * A result belongs to the trade that produced it.
   *
   * Without this, a success banner and its txid sit under a card the user has
   * since changed — which is how someone reads "Position opened" while looking
   * at different numbers, and worse, how an unconfirmed submission gets
   * mistaken for a confirmed one on the NEXT attempt.
   */
  useEffect(() => {
    setResult(null);
    setSubmitError(null);
    // `submitting` is deliberately NOT a dependency. It flips false at the end
    // of `submit()`, immediately after `setResult` — so including it made this
    // effect fire and wipe the result the user is waiting to see. The inputs
    // are locked while a signature is in flight, so they cannot change
    // mid-submission and this cannot clear a live attempt.
  }, [marketId, side, amount, tpPrice, barPos]);

  async function submit() {
    if (!canSubmit || !quote?.ok || !wallet.address || !data) return;
    setSubmitError(null);
    setResult(null);
    try {
      const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");
      const r = await openPosition({
        algod,
        signTransactions: (txns) => wallet.signTransactions(txns),
        sender: wallet.address,
        marketId,
        side,
        collateralUsd,
        notionalUsd: notional,
        takeProfitPrice12: tp12,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        /**
         * **The exact values this render put on screen.**
         *
         * `openPosition` re-reads everything and refuses if the market has
         * drifted past tolerance — but that check is only meaningful if these
         * are what the user actually saw. Audit 4 could not verify the guard
         * was non-circular because there was no caller; this is the caller, and
         * these three come from the same `quote` memo that renders the entry
         * price, the liquidation box and the payoff line. Do not "freshen"
         * them: a re-read here would turn the guard back into a tautology.
         */
        displayed: {
          // `data.oracle.indexPrice12`, NOT `quote.indexPrice12`. The market
          // tile renders the former (via `indexUsd`); the latter is the SDK's
          // own `index_price` echoed back through the quote. They are usually
          // equal, but "usually" is not what `asRendered` promises — and
          // passing the quote's copy would compare the fresh oracle against a
          // number the user never saw, which is the circularity this field
          // exists to prevent.
          asRenderedIndexPrice12: data.oracle.indexPrice12,
          asRenderedEntryPrice12: quote.entryPrice12,
          asRenderedLiquidationPrice12: quote.liquidationPrice12,
        },
        onStage: setStage,
      });
      setResult(r);
    } catch (e) {
      if (e instanceof PositionAlreadyOpenError) {
        setSubmitError(
          `You already have a position on this market and side (${fmtUsd(Number(e.sizeUsdMicro) / 1e6)}). Close it before opening another.`,
        );
      } else {
        setSubmitError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStage(null);
    }
  }

  const STAGE_LABEL: Record<OpenStage, string> = {
    preparing: "Preparing…",
    allocating: "Reserving an order id…",
    building: "Building the transaction group…",
    checking: "Running the safety check…",
    simulating: "Simulating against the exchange…",
    signing: "Waiting for your wallet…",
    submitting: "Submitting…",
    confirming: "Waiting for confirmation…",
  };

  return (
    <Panel className="p-5 sm:p-6">
      {/* Market */}
      <div className="flex items-center gap-2">
        {MARKETS.map((m) => {
          const on = m.id === marketId;
          return (
            <button key={m.id} disabled={submitting} onClick={() => {
                if (m.id === marketId) return;
                setMarketId(m.id);
                // A price means nothing across markets. $0.30 is a plausible ALGO
                // target and an absurd BTC one, and a short's lower bound is a
                // ten-thousandth of a cent — so a carried value validates and the
                // card cheerfully prints a 389% return. Clear it outright.
                setTpPrice("");
                setTpTouched(false);
              }}
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

      {(error || (data && !data.oracle.signatureVerified) || preflight.canOpen === false) && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {/* Most specific first: a contract or configuration problem is a
                better explanation than "data unavailable", which is what a
                failed preflight would otherwise also surface as. */}
            {preflight.canOpen === false ? (
              <>
                {preflight.reason}{" "}
                <button onClick={preflight.recheck} disabled={preflight.checking}
                  className="underline underline-offset-2 hover:text-amber-100 disabled:opacity-50">
                  {preflight.checking ? "Checking…" : "Retry"}
                </button>
              </>
            ) : error
              ? `Live market data unavailable — trading is disabled until it returns. (${error})`
              : "This price could not be verified against PEX's signing key, so trading is disabled."}
          </span>
        </div>
      )}

      {/* Direction */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {(["long", "short"] as Side[]).map((s) => {
          const on = s === side;
          const up = s === "long";
          return (
            <button key={s} disabled={submitting} onClick={() => { setSide(s); setTpTouched(false); }}
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
            onChange={(e) => {
              // Strip only what cannot change the number; refuse the rest and
              // say why. "12,50" used to become 1250. See perpsInput.
              const v = readNumericInput(e.target.value);
              if (!v.ok) { setAmountHint(v.hint); return; }
              setAmountHint(null);
              setAmount(v.value);
              // NOT `setTpTouched(false)`. Changing the amount used to discard a
              // take-profit the user had deliberately typed, replacing it with
              // the +50%-on-stake default. Unlike the market and side buttons
              // above, an amount edit does not make a price meaningless — the
              // target is still the target. While `tpTouched` is false the
              // default effect still tracks the amount, so the untouched case
              // is unaffected.
            }}
            disabled={submitting}
            className="w-full bg-transparent px-2 py-3 text-lg font-semibold tabular-nums text-white outline-none disabled:opacity-50" />
          <span className="text-xs text-white/40">USDC</span>
        </div>
        {amountHint && <p className="mt-1 text-xs text-amber-300/90">{amountHint}</p>}
      </label>

      {/* Risk */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-white/50">Risk</span>
          <span className="text-sm font-semibold tabular-nums text-white">
            {tradable && quote?.ok ? `${quote.leverage.toFixed(2)}×` : "—"}
          </span>
        </div>
        <input id="perps-risk" type="range" min={0} max={1} step={0.01} value={barPos}
          disabled={!tradable || submitting}
          onChange={(e) => setBarPos(Number(e.target.value))}
          className="mt-2 w-full accent-magnet-400 disabled:opacity-30" />
        <div className="flex justify-between text-[11px] tabular-nums text-white/40">
          <span>{tradable ? `${bar!.minLeverage.toFixed(2)}×` : ""}</span>
          <span>{tradable && collateralUsd > 0 ? `${(ceilingUsd / collateralUsd).toFixed(2)}×` : ""}</span>
        </div>
        {bar && !bar.open && (
          <p className="mt-1 text-xs text-amber-300/90">{bar.closedReason}</p>
        )}
        {/* Only blame the amount when the amount is actually the problem. This
            line used to render for every cause of `!tradable`, so during the
            contract check — and whenever that check failed — it told the user to
            try a different amount for something no amount would fix. */}
        {bar?.open && !tradable && preflight.canOpen === null && (
          <p className="mt-1 text-xs text-white/45">Verifying the exchange contracts…</p>
        )}
        {bar?.open && !tradable && preflight.canOpen === true && dataTrusted && (
          <p className="mt-1 text-xs text-amber-300/90">
            No size on this side currently clears the exchange&apos;s checks. Try a different amount.
          </p>
        )}
        {tradable && (
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
            {!quote?.ok ? "—" : liquidatable ? fmtPrice(price12ToUsd(quote.liquidationPrice12)) : "None"}
          </span>
        </div>
        {quote?.ok && liquidatable && indexUsd !== null && (
          <p className="mt-0.5 text-[11px] text-red-200/60">
            {side === "long" ? "Falls to" : "Rises to"} this and the position closes at a total loss of {fmtUsd(collateralUsd)}
            {" · "}{(Math.abs(price12ToUsd(quote.liquidationPrice12) - indexUsd) / indexUsd * 100).toFixed(1)}% away
          </p>
        )}
        {quote?.ok && !liquidatable && (
          <p className="mt-0.5 text-[11px] text-red-200/60">
            At this size your position is smaller than your collateral, so it cannot be liquidated.
            You can still lose money if the price moves against you.
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
            onChange={(e) => {
              const v = readNumericInput(e.target.value);
              if (!v.ok) { setTpHint(v.hint); return; }
              setTpHint(null);
              setTpPrice(v.value);
              setTpTouched(true);
            }}
            disabled={submitting}
            className="w-full bg-transparent px-2 py-3 font-semibold tabular-nums text-white outline-none disabled:opacity-50" />
        </div>
        {tpHint && <p className="mt-1 text-xs text-amber-300/90">{tpHint}</p>}
        {quote?.ok && (
          tpValid && tpPayoff !== null ? (
            <p className="mt-1 text-xs text-green-300/90">
              Closes for {fmtUsd(tpPayoff)} profit before costs
            </p>
          ) : (
            <p className="mt-1 text-xs text-amber-300/90">
              {!bounds
                ? "Enter a take-profit price."
                : tpTooNear
                  // The crossing guard. Named for what it does to the user's
                  // money, not for the bound it failed.
                  ? `That target is too close to the current price — it would trigger the moment the position opened, closing it straight away for a loss in fees. ${
                      side === "long"
                        ? `Choose a target above ${fmtPrice(price12ToUsd(bounds.minPrice12))}.`
                        : `Choose a target below ${fmtPrice(price12ToUsd(bounds.maxPrice12))}.`}`
                  : tpTypo
                    // Says "check it" rather than "impossible", because it is
                    // not impossible — it is almost certainly a stray decimal.
                    ? `That target is ${MAX_TAKE_PROFIT_MULTIPLE}× away from the current price — check the decimal point. ${
                        side === "long"
                          ? `The highest we accept is ${fmtPrice(price12ToUsd(bounds.maxPrice12))}.`
                          : `The lowest we accept is ${fmtPrice(price12ToUsd(bounds.minPrice12))}.`}`
                    : side === "long"
                      ? `Choose a target above ${fmtPrice(price12ToUsd(bounds.minPrice12))}.`
                      : `Choose a target below ${fmtPrice(price12ToUsd(bounds.maxPrice12))}.`}
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

      {/* Submit */}
      {!wallet.isConnected ? (
        <>
          <button disabled
            className="mt-5 w-full rounded-xl bg-magnet-500/20 py-3.5 text-sm font-semibold text-white/40 cursor-not-allowed">
            Connect your wallet to trade
          </button>
          <p className="mt-2 text-center text-[11px] text-white/35">
            Use the Connect button at the top of the page.
          </p>
        </>
      ) : (
        <button onClick={submit} disabled={!canSubmit}
          className={`mt-5 w-full rounded-xl py-3.5 text-sm font-semibold transition-colors ${
            canSubmit
              ? "bg-magnet-500 text-white hover:bg-magnet-400"
              : "bg-magnet-500/20 text-white/40 cursor-not-allowed"}`}>
          {submitting ? STAGE_LABEL[stage] : `Open ${side} · ${fmtUsd(notional)}`}
        </button>
      )}

      {/* One signature, and what it commits to — shown before the prompt, not after. */}
      {wallet.isConnected && !submitting && canSubmit && (
        <p className="mt-2 text-center text-[11px] text-white/35">
          One signature. {fmtUsd(collateralUsd)} collateral plus {fmtUsd(CHILD_KEEPER_FEE_USDC)} keeper fee leaves your wallet.
        </p>
      )}

      {submitError && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{submitError}</span>
        </div>
      )}

      {result && (
        <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${
          result.confirmed
            ? "border-green-400/30 bg-green-500/10 text-green-200"
            : "border-amber-400/30 bg-amber-500/10 text-amber-200"}`}>
          {/* An unobserved confirmation is NOT a failure — the group stays valid
              for the rest of its window and will most likely commit. Saying
              "failed" here is what produced a retry that doubled a position. */}
          <p className="font-medium">
            {result.confirmed ? "Position opened." : "Submitted — confirmation not seen yet."}
          </p>
          <p className="mt-1 text-[11px] opacity-80">
            {result.confirmed
              ? "Your take-profit is live and will close the position automatically."
              : "This is not a failure. The transaction is still valid and will most likely confirm. Check the link before trying again — opening a second time would add to the position."}
          </p>
          <a href={`https://allo.info/tx/${result.txId}`} target="_blank" rel="noopener noreferrer"
            className="mt-1.5 inline-block break-all underline underline-offset-2 opacity-90 hover:opacity-100">
            {result.txId}
          </a>
        </div>
      )}

      <p className="mt-2.5 text-center text-[10px] leading-relaxed text-white/30">
        Trades execute on <span className="text-white/45">PEX</span>, a third-party protocol by Ultrade.
        Magnet Strategies holds no funds and operates no exchange. PEX has had no external audit.
        {age !== null && <> · Price signed {age}s ago</>}
      </p>
    </Panel>
  );
}
