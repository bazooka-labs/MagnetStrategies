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
import { Seam } from "./Seam";
import {
  minimumCollateralUsd,
  notionalAtBarPosition,
  solveBar,
  type Side,
} from "@/lib/perpsSolver";
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
  SubmissionUnknownError,
  type OpenStage,
  type OpenPositionResult,
} from "@/lib/perpsClient";
import { parseMoney, readNumericInput } from "@/lib/perpsInput";

const MARKETS = Object.values(PEX_MARKETS).filter((m) => ENABLED_MARKET_IDS.includes(m.id));

/**
 * Profit targets offered as quick picks, as a fraction of the stake.
 *
 * Of the STAKE, not of the position: "+25%" on $100 of collateral means $25 of
 * profit, whatever leverage is set. That is the number a user actually has in
 * mind, and it is why the exit price moves when the slider does.
 */
const TP_TARGETS = [0.1, 0.25, 0.5] as const;

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

/**
 * The market is lifted so the chart beside the card shows the same one.
 *
 * Optional, so the card still works standalone — but when both are rendered
 * they must agree. A chart captioned ALGO/USD next to a BTC quote is the same
 * class of defect as any other "screen says one thing" bug.
 */
/**
 * The prices the card is currently quoting, for the chart to draw.
 *
 * Reported up rather than recomputed: the chart drawing its own entry or
 * liquidation would be a second opinion about a number the card already owns,
 * and two components deriving the same figure separately is how they come to
 * disagree. Nulls mean "nothing to draw" — no amount entered, or no
 * liquidation because notional is below collateral.
 */
export type CardOverlay = {
  entryPrice12: bigint | null;
  liquidationPrice12: bigint | null;
  takeProfitPrice12: bigint | null;
  stopLossPrice12: bigint | null;
  side: Side;
};

export type PerpsCardProps = {
  marketId?: number;
  onMarketChange?: (id: number) => void;
  onOverlayChange?: (o: CardOverlay) => void;
};

export function PerpsCard({
  marketId: controlledMarketId, onMarketChange, onOverlayChange,
}: PerpsCardProps = {}) {
  const [ownMarketId, setOwnMarketId] = useState<number>(ACTIVE_MARKET_ID);
  const marketId = controlledMarketId ?? ownMarketId;
  const setMarketId = (id: number) => {
    setOwnMarketId(id);
    onMarketChange?.(id);
  };
  const [side, setSide] = useState<Side>("long");
  /**
   * Empty, not pre-filled.
   *
   * A default stake is a number the product chose, sitting in the field that
   * decides how much of the user's money is at risk — and one they can sign
   * without ever having typed. Every figure below is derived from it, so an
   * untouched card was quoting a real $100 position at a real liquidation price.
   */
  const [amount, setAmount] = useState<string>("");
  const [barPos, setBarPos] = useState<number>(0.5);
  const [tpPrice, setTpPrice] = useState<string>("");
  /**
   * The chosen profit target as a fraction of stake, or null for a hand-typed
   * price. Null is also the starting state: the field begins empty.
   */
  const [tpPct, setTpPct] = useState<number | null>(null);
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
  /** Declared with `stage` so effects above the render can read it too. */
  const submitting = stage !== null;
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
  /**
   * Clear the take-profit whenever the market changes.
   *
   * This used to live in the market buttons' onClick. Those buttons moved above
   * the chart, and the guard has to move with them — a price means nothing
   * across markets: $0.30 is a plausible ALGO target and an absurd BTC one, and
   * a short's lower bound is a ten-thousandth of a cent, so a carried value
   * VALIDATES and the card cheerfully prints a 389% return. That was H2.
   *
   * Keyed on `marketId` rather than on a click, so the guard holds however the
   * market is changed — including by a caller that does not exist yet.
   */
  useEffect(() => {
    setTpPrice("");
    setTpPct(null);
  }, [marketId]);

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
    // The solver's own function, not a copy of its arithmetic. The inline
    // version omitted its clamp on `t` — harmless while the slider is the only
    // caller, and exactly the "card owns its own copy" pattern that let the
    // display precision drift away from the bound it was printing.
    return notionalAtBarPosition({ ...bar, maxNotionalUsd: ceilingUsd }, barPos);
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

  /**
   * The take-profit follows a chosen profit target, or nothing at all.
   *
   * It used to default to +50% of stake on mount. That put a number the product
   * chose into the field that decides where the position exits — and because it
   * was recomputed from `quote`, it also moved on its own as the slider and the
   * market changed, which looked like the card editing itself.
   *
   * Now the field starts empty and fills only when a target is picked. Once
   * picked it DOES track the slider, because that is the point: "+25% on my
   * stake" is a different price at 3x than at 12x, and the user asked for the
   * profit, not the price.
   *
   * Typing a price clears the target (see the input's onChange) — a hand-typed
   * exit must not be overwritten by a slider nudge.
   */
  useEffect(() => {
    // Frozen while signing: `disabled` stops the user editing this field, not
    // this effect, and the group carries the value from the click.
    if (submitting) return;
    if (tpPct === null || !quote?.ok) return;

    // `priceForPayoff` returns null when the profit exceeds what the position
    // can pay — a short's ceiling is its notional, and both markets are
    // OI-capped well below typical collateral. Nothing is written in that case;
    // the button reports it rather than the field showing a wrong number.
    const wanted = priceForPayoff(quote, collateralUsd * tpPct);
    if (!wanted) { setTpPrice(""); return; }

    // Clamp into the band the card enforces. At high leverage a small
    // percentage of stake is a small price move, which can land inside the
    // crossing guard — and a card showing its own invalid target is worse than
    // one showing a conservative one.
    const b = displayTakeProfitBounds(quote);
    const clamped = wanted < b.minPrice12 ? b.minPrice12
      : wanted > b.maxPrice12 ? b.maxPrice12 : wanted;
    setTpPrice(price12ToUsd(clamped).toFixed(priceDisplayDecimals(price12ToUsd(clamped))));
  }, [quote, collateralUsd, tpPct, submitting]);

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
  /**
   * Report the quoted prices up for the chart to draw.
   *
   * Keyed on the live quote rather than the frozen view: the chart should show
   * where the market actually is, even mid-signature. `tpValid` gates the
   * take-profit so a half-typed target does not draw a line at $1.
   */
  useEffect(() => {
    onOverlayChange?.({
      entryPrice12: quote?.ok ? quote.entryPrice12 : null,
      liquidationPrice12: quote?.ok && quote.liquidationDirection !== ""
        && quote.liquidationPrice12 > BigInt(0) ? quote.liquidationPrice12 : null,
      takeProfitPrice12: tpValid && tp12 > BigInt(0) ? tp12 : null,
      // Protection is not enabled yet; when it is, its trigger goes here and
      // the chart already knows how to draw it.
      stopLossPrice12: null,
      side,
    });
  }, [quote, tpValid, tp12, side, onOverlayChange]);

  const liquidatable = !!(quote?.ok
    && quote.liquidationDirection !== "" && quote.liquidationPrice12 > BigInt(0));
  // attemptAt changes on every load attempt, so this re-renders and keeps
  // ageing even when a repeated identical error would otherwise freeze it.
  void attemptAt;
  const age = oracleAgeSeconds(data);
  /** The smallest stake this market will accept right now. */
  const minCollateral = useMemo(() => {
    if (!data) return null;
    try {
      return minimumCollateralUsd(
        data.state, data.state.core, data.oracle.indexPrice12, POSITION_BUILDER_FEE_BPS,
      );
    } catch { return null; }
    // Not side-dependent: the floor comes from `min_collateral_usd` and the fee
    // fraction, neither of which differs by side.
  }, [data]);

  /**
   * The money figures as they were when the user clicked.
   *
   * Audit 5 froze the take-profit while signing but not the other fourteen
   * figures derived from `quote`, `bar` and `notional` — all memos over `data`,
   * which the hook replaces every ten seconds. During a 20-40 second mobile or
   * hardware prompt the position size, liquidation price and whole cost table
   * kept repainting while the group being signed carried the click-time values;
   * and if `bar.open` or the preflight flipped, `tradable` went false and those
   * figures **vanished** mid-prompt.
   *
   * The drift guard is structurally blind to this — it compares the fresh probe
   * against the click-time `displayed` values, not against what the screen is
   * showing now. Freezing the view is the fix.
   */
  const [frozen, setFrozen] = useState<{
    quote: OpenQuote | null; notional: number; collateralUsd: number; tpPrice: string;
  } | null>(null);
  /** What the card renders. The live memos keep updating underneath. */
  const view = frozen ?? { quote, notional, collateralUsd, tpPrice };
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
    // **Only the market and side.** This used to depend on `tpPrice` too, and
    // `tpPrice` is rewritten by the auto-default effect above on every refresh
    // tick — so the result banner and its txid deleted themselves within about
    // ten seconds of the trade completing, taking the "do not open again"
    // warning with them and re-arming the button. Market and side are genuine
    // user gestures that mean "different trade"; an amount or slider nudge does
    // not, and neither does a machine-driven take-profit refresh.
    //
    // `submitting` is deliberately not a dependency either: it flips false
    // immediately after `setResult`, so including it wiped the result too.
    setResult(null);
    setSubmitError(null);
    // `wallet.address` belongs here for the same reason market and side do: it
    // is a genuine gesture meaning "different trade". Without it, account A's
    // "confirmation not seen yet" banner, its txid and its "opening a second
    // time would add to the position" warning sat under account B's card.
  }, [marketId, side, wallet.address]);

  async function submit() {
    if (!canSubmit || !quote?.ok || !wallet.address || !data) return;
    // The previous outcome is cleared HERE, by the gesture that supersedes it,
    // rather than by whichever input happened to change.
    setSubmitError(null);
    setResult(null);
    setFrozen({ quote, notional, collateralUsd, tpPrice });
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
          // The same `netCollateralUsd` the cost table prints as
          // "Backing the position", scaled the way the guard compares it.
          asRenderedNetCollateralMicro: BigInt(Math.round(quote.netCollateralUsd * 1e6)),
        },
        onStage: setStage,
      });
      setResult(r);
    } catch (e) {
      if (e instanceof SubmissionUnknownError) {
        // Sent, response lost. Never "failed" — show it like an unconfirmed
        // submission, with the link, because the group may already be on chain.
        setResult({
          txId: e.txId, outcome: "unknown", reason: e.cause,
          baseOrderId: BigInt(0), checks: [], confirmed: false,
        });
      } else if (e instanceof PositionAlreadyOpenError) {
        setSubmitError(
          `You already have a position on this market and side (${fmtUsd(Number(e.sizeUsdMicro) / 1e6)}). Close it before opening another.`,
        );
      } else {
        setSubmitError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStage(null);
      setFrozen(null);
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

  // A section, not a panel. PerpsView wraps the chart, this and the positions
  // list in ONE card, so reading the market, opening a position and watching
  // it are visibly the same surface; the border, background and top hairline
  // live on that wrapper. The seam separates this from the chart above it.
  return (
    <>
      <Seam />
      <div className="p-5 sm:p-6">
      {/* The market toggle lives above the chart now, not here. */}
      <div className="flex items-baseline justify-between">
        <span className="font-display text-base font-semibold text-white">{market.label}</span>
        <span className="text-xs tabular-nums text-white/45">
          {indexUsd !== null ? fmtPrice(indexUsd) : loading ? "…" : ""}
        </span>
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

      {/* Laid out across rather than down. In a 420px column this was a long
          scroll; with the chart leading the page there is width to use, and the
          three groups below are the three decisions in order: what and how
          much, where to exit, what it costs. */}
      <div className="mt-4 grid gap-x-6 gap-y-1 lg:grid-cols-3">

      <div>
      {/* Direction */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {(["long", "short"] as Side[]).map((s) => {
          const on = s === side;
          const up = s === "long";
          return (
            <button key={s} disabled={submitting} onClick={() => { setSide(s); setTpPct(null); setTpPrice(""); }}
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
            placeholder="0.00"
            className="w-full bg-transparent px-2 py-3 text-lg font-semibold tabular-nums text-white outline-none placeholder:text-white/25 disabled:opacity-50" />
          <span className="text-xs text-white/40">USDC</span>
        </div>
        {amountHint && <p className="mt-1 text-xs text-amber-300/90">{amountHint}</p>}
      </label>

      {/* Risk */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-white/50">Risk</span>
          <span className="text-sm font-semibold tabular-nums text-white">
            {tradable && view.quote?.ok ? `${view.quote.leverage.toFixed(2)}×` : "—"}
          </span>
        </div>
        <input id="perps-risk" type="range" min={0} max={1} step={0.01} value={barPos}
          disabled={!tradable || submitting}
          onChange={(e) => setBarPos(Number(e.target.value))}
          className="mt-2 w-full accent-magnet-400 disabled:opacity-30" />
        <div className="flex justify-between text-[11px] tabular-nums text-white/40">
          <span>{tradable ? `${bar!.minLeverage.toFixed(2)}×` : ""}</span>
          <span>{tradable && collateralUsd > 0 ? `${(ceilingUsd / view.collateralUsd).toFixed(2)}×` : ""}</span>
        </div>
        {collateralUsd <= 0 && (
          <p className="mt-1 text-xs text-white/40">
            Enter an amount above to see your size, leverage and liquidation price.
          </p>
        )}
        {bar && !bar.open && (
          <p className="mt-1 text-xs text-amber-300/90">
            {bar.closedReason}
            {/* `minimumCollateralUsd` existed to answer exactly this and had no
                caller, so the card said "too small" without saying too small
                for what. */}
            {minCollateral !== null && ` You need at least ${fmtUsd(minCollateral)}.`}
          </p>
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
            Position size {fmtUsd(view.notional)} · limited by {bar.binding.replace(/_/g, " ")}
          </p>
        )}
      </div>

      </div>

      <div>
      {/* Liquidation — permanent, not a disclosure the user can dismiss */}
      <div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/[0.07] px-3.5 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-red-300/80">Liquidation</span>
          <span className="text-base font-bold tabular-nums text-red-300">
            {!view.quote?.ok ? "—" : liquidatable ? fmtPrice(price12ToUsd(view.quote.liquidationPrice12)) : "None"}
          </span>
        </div>
        {view.quote?.ok && liquidatable && indexUsd !== null && (
          <p className="mt-0.5 text-[11px] text-red-200/60">
            {side === "long" ? "Falls to" : "Rises to"} this and the position closes at a total loss of {fmtUsd(view.collateralUsd)}
            {" · "}{(Math.abs(price12ToUsd(view.quote.liquidationPrice12) - indexUsd) / indexUsd * 100).toFixed(1)}% away
          </p>
        )}
        {view.quote?.ok && !liquidatable && (
          <p className="mt-0.5 text-[11px] text-red-200/60">
            At this size your position is smaller than your collateral, so it cannot be liquidated.
            You can still lose money if the price moves against you.
          </p>
        )}
      </div>

      {/* Take profit — mandatory */}
      <label className="mt-4 block">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-white/50">
            Take profit at {market.label.split("/")[0]} price
          </span>
          {/* Profit targets, as a fraction of the stake. Picking one makes the
              exit price follow the risk slider — "+25% on my stake" is a
              different price at 3x than at 12x, and the profit is what was
              asked for. Clicking the active one clears it. */}
          <div className="flex gap-1">
            {TP_TARGETS.map((pct) => {
              const on = tpPct === pct;
              const reachable = !quote?.ok || priceForPayoff(quote, collateralUsd * pct) !== null;
              return (
                <button key={pct} type="button" disabled={submitting || !reachable}
                  onClick={() => setTpPct(on ? null : pct)}
                  title={reachable ? undefined : "This position cannot make that much"}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    on ? "bg-green-500/20 text-green-200"
                      : reachable ? "bg-white/[0.04] text-white/45 hover:text-white/75"
                      : "bg-white/[0.02] text-white/20 cursor-not-allowed"}`}>
                  +{Math.round(pct * 100)}%
                </button>
              );
            })}
          </div>
        </div>
        <div className="mt-1.5 flex items-center rounded-xl border border-white/10 bg-black/40 px-3">
          <span className="text-white/40">$</span>
          <input id="perps-tp" inputMode="decimal" value={view.tpPrice}
            onChange={(e) => {
              const v = readNumericInput(e.target.value);
              if (!v.ok) { setTpHint(v.hint); return; }
              setTpHint(null);
              setTpPrice(v.value);
              // A hand-typed exit is a deliberate choice; drop the percentage so
              // a slider nudge cannot overwrite it.
              setTpPct(null);
            }}
            disabled={submitting}
            className="w-full bg-transparent px-2 py-3 font-semibold tabular-nums text-white outline-none disabled:opacity-50" />
        </div>
        {tpHint && <p className="mt-1 text-xs text-amber-300/90">{tpHint}</p>}
        {view.quote?.ok && (
          tpValid && tpPayoff !== null ? (
            <p className="mt-1 text-xs text-green-300/90">
              Closes for {fmtUsd(tpPayoff)} profit before costs
            </p>
          ) : (
            <p className="mt-1 text-xs text-amber-300/90">
              {/* Empty is now the starting state, so it gets its own line —
                  "choose a target above $X" reads as a correction for a number
                  the user has not entered yet. */}
              {view.tpPrice.trim() === ""
                ? "Pick a profit target above, or type an exit price. Every position needs one."
                : !bounds
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

      </div>

      <div>
      {/* Costs */}
      {view.quote?.ok && (
        <dl className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-xs">
          {[
            ["Entry price", fmtPrice(price12ToUsd(view.quote.entryPrice12))],
            ["PEX fee", fmtUsd(view.quote.openFeeUsd)],
            [`Magnet fee (${POSITION_BUILDER_FEE_BPS} bps, charged again on close)`, fmtUsd(view.quote.builderFeeUsd)],
            ["Price impact", `${view.quote.impactUsd >= 0 ? "+" : "−"}${fmtUsd(Math.abs(view.quote.impactUsd))}`],
            ["Backing the position", fmtUsd(view.quote.netCollateralUsd)],
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
          {submitting ? STAGE_LABEL[stage] : `Open ${side} · ${fmtUsd(view.notional)}`}
        </button>
      )}

      {/* One signature, and what it commits to — shown before the prompt, not after. */}
      {/* Visible DURING signing too. This is the only line that enumerates what
          moves, and gating it on `!submitting` hid it exactly when the user was
          being asked to approve. */}
      {wallet.isConnected && (canSubmit || submitting) && (
        <p className="mt-2 text-center text-[11px] text-white/35">
          {/* "Returned when you close" was false. Closing moves the escrow from
              locked to available INSIDE PEX, not back to the wallet — recovering
              it needs withdraw_storage_credit or close_storage_account, and we
              offer neither. Nine of the nineteen live PEX traders are sitting on
              idle escrow right now. And ~0.15-0.25 ALGO is not "small" against
              the stakes this card is built for, so it is quantified. */}
          One signature. {fmtUsd(view.collateralUsd)} collateral and {fmtUsd(CHILD_KEEPER_FEE_USDC)} keeper
          fee leave your wallet, plus about 0.15 ALGO for the on-chain order record
          — or 0.25 on your first PEX trade, which also sets up a storage record PEX keeps.
        </p>
      )}

      {submitError && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{submitError}</span>
        </div>
      )}

      {result && (
        /* Three outcomes, three treatments. An unobserved confirmation is NOT a
           failure — the group stays valid and will most likely commit, and
           calling it failed is what produced the retry that doubled a position.
           A REJECTION is a failure, and saying "this will most likely confirm"
           about one is worse: it steers the user away from the correct action. */
        <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${
          result.outcome === "confirmed"
            ? "border-green-400/30 bg-green-500/10 text-green-200"
            : result.outcome === "rejected"
              ? "border-red-400/30 bg-red-500/10 text-red-200"
              : "border-amber-400/30 bg-amber-500/10 text-amber-200"}`}>
          <p className="font-medium">
            {result.outcome === "confirmed" ? "Position opened."
              : result.outcome === "rejected" ? "The network rejected this — nothing was opened."
              : "Submitted — confirmation not seen yet."}
          </p>
          <p className="mt-1 text-[11px] opacity-80">
            {result.outcome === "confirmed"
              ? "Your take-profit is live and will close the position automatically."
              : result.outcome === "rejected"
                ? `Nothing left your wallet and no position exists. You can safely try again.${result.reason ? ` Reason: ${result.reason}` : ""}`
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
      </div>
      </div>
      </div>
    </>
  );
}
