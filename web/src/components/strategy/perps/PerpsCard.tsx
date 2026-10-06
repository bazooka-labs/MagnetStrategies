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
// The MBRs the client actually bills, so the disclosure cannot drift from the
// group it describes — audit 9, MEDIUM 3.
import {
  LIMIT_ORDER_BOX_MBR_MICRO_ALGO,
  ORDER_BOX_MBR_MICRO_ALGO,
  STORAGE_ESCROW_MICRO_ALGO,
} from "@/lib/perpsGroup";
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
  quickPickPrice,
  type QuickPick,
  quoteOpen,
  displayTakeProfitBounds,
  formatPriceUsd,
  priceDisplayDecimals,
  type OpenQuote,
  capacityOnlyFailure,
  stopLossBounds,
} from "@/lib/perpsQuote";
import { sideOiUsd } from "@/lib/perpsReads";
import { oracleAgeSeconds, usePerpsMarket } from "@/hooks/usePerpsMarket";
import { usePerpsPreflight } from "@/hooks/usePerpsPreflight";
import { useWallet } from "@/hooks/useWallet";
import { ALGOD_URLS } from "@/lib/constants";
import {
  openLimitOrder,
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

/**
 * Every figure the card displays, captured together.
 *
 * The type exists so the freeze cannot be partial again: adding a displayed
 * value means adding it here, and the compiler then requires it at the one
 * place `live` is built. See the comment on `live` for what audit 7 found.
 */
/** One side of a market's book: how much is on it, and the most that may be. */
type OiSide = { pct: number; usedUsd: number; capUsd: number };

type CardSnapshot = {
  quote: OpenQuote | null;
  notional: number;
  collateralUsd: number;
  tpPrice: string;
  tradable: boolean;
  liquidatable: boolean;
  /** The quote is good enough to show and sign against — see `quoteUsable`. */
  quoteUsable: boolean;
  tpValid: boolean;
  /** Stop-loss, frozen with everything else. Audit 7: a field added to the card
   *  and not to the snapshot is read LIVE at the render site. */
  slPrice: string;
  slEmpty: boolean;
  slValid: boolean;
  slTooNear: boolean;
  slPastLiquidation: boolean;
  tpPayoff: number | null;
  ceilingUsd: number;
  indexUsd: number | null;
  minLeverage: number | null;
  binding: string | null;
  /** The selected chip's resolution, so its message cannot repaint mid-prompt. */
  quickPick: QuickPick | null;
  /** Every chip's resolution, keyed by target. Frozen for the same reason. */
  chipPicks: Record<number, QuickPick>;
  /** Market or limit, and the trigger — the labels below depend on both. */
  isLimit: boolean;
  /** Limit mode, and the market has no room for this size today. */
  waitsForRoom: boolean;
  trigger12: bigint;
  /** The traded side's open interest, and the cap it sits under. */
  openInterest: OiSide | null;
  /** Which way funding flows and the paying side's annualised rate — or that
   *  nobody is paying, which is a state and not an absence. */
  funding:
    | { charged: true; annualPct: number; youPay: boolean; ceilingPct: number }
    | { charged: false; ceilingPct: number }
    | null;
  /** No target set — a choice now, and the button and warnings reflect it. */
  tpEmpty: boolean;
  /** What this signature moves, derived from the constants. Frozen with the rest. */
  moves: { keeperUsd: number; algo: number; algoFirstTrade: number };
};

export type PerpsCardProps = {
  marketId?: number;
  onMarketChange?: (id: number) => void;
  onOverlayChange?: (o: CardOverlay) => void;
  /**
   * True while a signature is in flight.
   *
   * Reported up because the market toggle lives in the chart panel now, and a
   * market switch mid-prompt repaints the labels around a frozen quote — see
   * audit 7 finding 4. One-directional, like `onOverlayChange`.
   */
  onBusyChange?: (busy: boolean) => void;
};

/**
 * What actually caps the size, in words a user can act on.
 *
 * This rendered the raw enum, so a user whose size was capped by a nearly-full
 * order book read "limited by oi headroom". Two separate reports came in
 * reading a CORRECT number as a bug — 1.1x on $10, and 0.8x the day before —
 * because the figure looked wrong and the label explained nothing.
 *
 * `oi_headroom` and `reserves` are the two worth naming properly: they are
 * conditions of the MARKET rather than of the user's own position, they move on
 * their own, and the other side or the other market is usually wide open.
 */
const BINDING_LABEL: Record<string, string> = {
  margin: "the leverage limit at this size",
  collateral: "the amount you entered",
  oi_headroom: "how much room this side of the market has left",
  reserves: "this market's available liquidity",
  sanity_cap: "our own size cap",
};

export function PerpsCard({
  marketId: controlledMarketId, onMarketChange, onOverlayChange, onBusyChange,
}: PerpsCardProps = {}) {
  const [ownMarketId, setOwnMarketId] = useState<number>(ACTIVE_MARKET_ID);
  const marketId = controlledMarketId ?? ownMarketId;
  const setMarketId = (id: number) => {
    setOwnMarketId(id);
    onMarketChange?.(id);
  };
  const [side, setSide] = useState<Side>("long");
  /**
   * Market or limit.
   *
   * A limit entry is a different economic object, not a setting on this one: it
   * escrows money and creates nothing until a keeper acts. It goes through
   * `openLimitOrder`, which has its own group shape and its own assertion.
   */
  const [mode, setMode] = useState<"market" | "limit">("market");
  /** Hoisted: the bar and the ceiling both need it, and both run above the
   *  old declaration site. */
  const isLimit = mode === "limit";
  /** The price a limit entry waits for, as typed. */
  const [triggerPrice, setTriggerPrice] = useState<string>("");
  const [triggerHint, setTriggerHint] = useState<string | null>(null);
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
  /** Optional stop-loss. Empty means none, exactly as the take-profit does. */
  const [slPrice, setSlPrice] = useState<string>("");
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
  const [slHint, setSlHint] = useState<string | null>(null);

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
    setSlPrice("");
    /**
     * `triggerPrice` too — audit 8 SHIP-BLOCKER 2.
     *
     * It was reset only by the mode toggle, and the market toggle lives outside
     * this card and changes nothing but `marketId`. So a $0.12 ALGO trigger
     * carried onto BTC/USD, and the crossing guard did not catch it: it tests
     * `trigger >= index`, and `1.2e11 >= 8.46e16` is false. The card then quoted
     * against a payload rescaled to the stale trigger and rendered an entry of
     * $0.120249 and a liquidation of $0.093459 on a market at $84,573 — submit
     * enabled.
     *
     * A short tripped its own crossing test; a long did not. This belongs here
     * rather than in a guard: a price typed for one market is not a price for
     * another, whatever its magnitude.
     */
    setTriggerPrice("");
    setTriggerHint(null);
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
      // A resting limit order opens nothing now, so the market's CURRENT
      // capacity is not its constraint. See the note on the option.
      marketCapacityApplies: !isLimit,
      prices: {
        indexPrice12: data.oracle.indexPrice12,
        longPrice12: (d.longMinPrice + d.longMaxPrice) / BigInt(2),
        shortPrice12: (d.shortMinPrice + d.shortMaxPrice) / BigInt(2),
      },
    });
  }, [data, side, collateralUsd, isLimit]);

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
      // Must match the bar's. Widening the bar without widening this leaves
      // every candidate rejected by `quoteOpen` and the ceiling pinned at the
      // floor — the same wrong answer by a longer route.
      }, { marketCapacityApplies: !isLimit });
    } catch { return null; }
  }, [data, bar, side, collateralUsd]);

  /**
   * Would this size open RIGHT NOW, ignoring that it is a limit order?
   *
   * Computed only in limit mode, and only to be honest about what the capacity
   * terms no longer binding actually means: the order is placeable, but a keeper
   * cannot fill it until the market has room. Saying nothing would mean offering
   * 6x on a market with $1.63 of long headroom and letting the user find out as
   * an order that silently never fills.
   *
   * Not a refusal. Headroom moves constantly, and a resting order waiting for
   * room is a legitimate thing to want — it is the whole point of resting.
   */
  const capacityNow = useMemo(() => {
    if (!data || !isLimit || collateralUsd <= 0) return null;
    const d = data.oracle.decoded;
    return solveBar(data.state, side, collateralUsd, data.oracle.indexPrice12, {
      prices: {
        indexPrice12: data.oracle.indexPrice12,
        longPrice12: (d.longMinPrice + d.longMaxPrice) / BigInt(2),
        shortPrice12: (d.shortMinPrice + d.shortMaxPrice) / BigInt(2),
      },
    });
  }, [data, side, collateralUsd, isLimit]);

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

  /**
   * Which side funding is flowing FROM, and how fast.
   *
   * An earlier version of this showed "this side is 80% full", which measures
   * capacity and not benefit — it told a user how crowded the side was without
   * telling them what it costs or pays to be there.
   *
   * ── What is read, and what is derived ─────────────────────────────────────
   * `saved_factor_side` is PEX's own statement of which side pays: 1 long,
   * 2 short, 0 neither. That is read, not inferred from the imbalance.
   *
   * The rate is `saved_factor_milli_bps` annualised over
   * `funding_interval_seconds`. **Verified against actual accrual** rather than
   * trusted: on 2026-09-29 the factor implied 74.9%/yr and the two live short
   * positions had accrued 75.6% and 72.9%, measured as the drift in their
   * `funding_fee_per_size` index over their holding period. Two independent
   * confirmations on the paying side.
   *
   * ── Why the RECEIVING side gets no number ────────────────────────────────
   * What the other side receives is not this rate. It depends on
   * `opposing_trader_share_bps` (2500 — a quarter) and on the size ratio
   * between the sides, and the same measurement showed longs accruing 36.6%,
   * 20.3%, 11.6% and several zeroes, the zeroes being staleness rather than a
   * real zero (the index only advances when `update_funding` runs). So the
   * direction is stated and the receiving figure is not invented.
   */
  /**
   * Open interest on the side being traded, and the cap it sits under.
   *
   * ONE SIDE, not two. The first version showed both and titled the pair "Open
   * interest", which conflated two things: the open interest is the DOLLARS,
   * and the percentage is those dollars against the cap. Under one heading the
   * percentage read as though it were the open interest itself. Both now name
   * themselves, and the side shown is the side being traded — the one whose
   * headroom actually caps the order on screen.
   *
   * NOT "pool utilisation", though the bar looks like one. This is
   * `max_open_interest_*` — the `oi_headroom` constraint, "how much room this
   * side of the market has left". The pool's own limit is a DIFFERENT check
   * (`checkReservesAfterTrade`, reason `*_reserves_exceeded`, labelled "this
   * market's available liquidity") against different fields in the `mp2:` box.
   * Naming this one after that one would have the card contradict itself two
   * lines apart.
   *
   * Null only when the market publishes no cap: a bar against no limit is a
   * lie. A cap with nothing against it is NOT null — zero is a state, and this
   * is the third place a true zero was rendering as an absence.
   */
  const openInterest = useMemo(() => {
    if (!data) return null;
    const cap = side === "long"
      ? data.state.risk.max_open_interest_long
      : data.state.risk.max_open_interest_short;
    if (cap <= BigInt(0)) return null;
    const used = sideOiUsd(data.state.oi, side);
    return {
      pct: (Number(used) / Number(cap)) * 100,
      usedUsd: Number(used) / 1e6,
      capUsd: Number(cap) / 1e6,
    };
  }, [data, side]);

  /**
   * Funding: who pays, how much, or that nobody does.
   *
   * ZERO IS A STATE, NOT MISSING DATA. This returned null on a zero factor, so
   * a market charging no funding rendered no funding line at all — and the
   * absence read as a missing feature rather than as "it is free here right
   * now". BTC sat at exactly that: `saved_factor_milli_bps=0`,
   * `saved_factor_side=0`, adaptive mode on and unramped, while ALGO showed a
   * rate on the same screen.
   *
   * The direction still comes from `saved_factor_side` and is NEVER inferred
   * from the imbalance (AUDIT.md item 16). That is why the zero branch names
   * no side: with no paying side recorded there is nothing to read a direction
   * from, and the one-sided book is not permission to guess which way it will
   * fall when the controller does move.
   *
   * `max_factor_milli_bps` is the clamp on `saved_factor_milli_bps` — ALGO sits
   * at exactly that value — so it is quotable as a ceiling. The RAMP, by
   * contrast, is undocumented on our side, so this says the rate moves without
   * claiming when or in whose favour.
   */
  const funding = useMemo(() => {
    if (!data) return null;
    const factor = Number(data.state.adaptive.saved_factor_milli_bps);
    const payingSide = Number(data.state.adaptive.saved_factor_side);
    const interval = Number(data.state.risk.funding_interval_seconds);
    if (interval <= 0) return null;
    // milli-bps is 1e-7 as a fraction; annualise over the interval.
    const annual = (f: number) => (f / 1e7) * (31_536_000 / interval) * 100;
    const ceilingPct = annual(Number(data.state.adaptive.max_factor_milli_bps));
    if (factor <= 0) return { charged: false as const, ceilingPct };
    // A positive factor with no readable paying side is a state we have never
    // seen and cannot describe without inventing a direction. Stay silent
    // rather than guess — the one case where showing nothing is still right.
    if (payingSide !== 1 && payingSide !== 2) return null;
    return {
      charged: true as const,
      annualPct: annual(factor),
      youPay: payingSide === (side === "long" ? 1 : 2),
      ceilingPct,
    };
  }, [data, side]);

  const trigger12 = usdToPrice12(triggerPrice) ?? BigInt(0);

  /**
   * The oracle payload the CARD quotes against.
   *
   * For a market order this is the live payload. For a limit order it is the
   * same payload with its prices moved to the user's trigger, because that is
   * where the order fills — quoting a resting order at today's index describes
   * a trade that will never happen.
   *
   * **Display only.** `openLimitOrder` builds the group from the real payload
   * it fetches itself; this object never reaches a transaction. A synthetic
   * payload in a group would be a signature over a price nobody published, so
   * the two paths are kept deliberately separate rather than sharing one value.
   *
   * Measured on MainNet: moving the payload to the trigger changes exactly two
   * displayed figures — entry price and liquidation price, both by the trigger
   * offset. Impact, both fees and "backing the position" are identical because
   * they scale with notional, not price; and liquidation DISTANCE is identical
   * because liquidation scales with entry. So the conditional part of a limit
   * quote is two numbers, not the whole table.
   */
  const quoteOracle = useMemo(() => {
    if (!data) return null;
    if (!isLimit || trigger12 <= BigInt(0)) return data.oracle;
    const live = data.oracle.indexPrice12;
    if (live <= BigInt(0)) return data.oracle;
    const scale = (v: bigint) => (v * trigger12) / live;
    return {
      ...data.oracle,
      indexPrice12: trigger12,
      decoded: {
        ...data.oracle.decoded,
        indexMinPrice: scale(data.oracle.decoded.indexMinPrice),
        indexMaxPrice: scale(data.oracle.decoded.indexMaxPrice),
      },
    };
  }, [data, isLimit, trigger12]);

  const quote: OpenQuote | null = useMemo(() => {
    if (!data || !quoteOracle || !bar?.open || notional <= 0) return null;
    // A limit order with no trigger yet has nothing to quote against.
    if (isLimit && trigger12 <= BigInt(0)) return null;
    try {
      return quoteOpen({
        state: data.state, oracle: quoteOracle, side,
        collateralUsd, notionalUsd: notional,
        builderAddress: BUILDER_ADDRESS || "A".repeat(58),
        collateralAssetId: COLLATERAL_ASSET_ID,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
    } catch { return null; }
  }, [data, quoteOracle, bar, notional, side, collateralUsd, isLimit, trigger12]);

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
  /**
   * Every chip resolved once, rather than three times per render.
   *
   * Also the source for the chips' own enabled state, so the buttons and the
   * message beneath them cannot disagree — review found the chips resolving
   * live while the message was frozen, which let them grey out against a payoff
   * line still quoting the old target mid-prompt.
   */
  const chipPicks = useMemo(() => {
    const out: Record<number, QuickPick> = {};
    if (quote?.ok) for (const pct of TP_TARGETS) out[pct] = quickPickPrice(quote, collateralUsd * pct);
    return out;
  }, [quote, collateralUsd]);
  const quickPick = tpPct === null ? null : chipPicks[tpPct] ?? null;

  useEffect(() => {
    // Frozen while signing: `disabled` stops the user editing this field, not
    // this effect, and the group carries the value from the click.
    if (submitting) return;
    if (quickPick === null) return;
    // Nothing is written for a target the card will not stand behind; the
    // message below the chips reports it rather than the field showing a price
    // that is not what the chip says.
    if (!quickPick.ok) { setTpPrice(""); return; }
    const usd = price12ToUsd(quickPick.price12);
    setTpPrice(usd.toFixed(priceDisplayDecimals(usd)));
  }, [quickPick, submitting]);

  // String -> Price12 exactly; a BTC price times 1e12 overflows Number precision.
  const tp12 = usdToPrice12(tpPrice) ?? BigInt(0);
  /** No target typed at all. See `canSubmit` for why that is now allowed. */
  const tpEmpty = tpPrice.trim() === "";
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

  // ── Stop-loss ──────────────────────────────────────────────────────────────
  const sl12 = usdToPrice12(slPrice) ?? BigInt(0);
  const slEmpty = slPrice.trim() === "";
  /**
   * Against the index BAND, not the index price — and only on market entries.
   *
   * The first version compared to `data.oracle.indexPrice12`, a point. PEX
   * crosses a `DECREASE_STOP_LOSS` at `indexMin` for a long and `indexMax` for a
   * short, and the index price sits between them, so every stop in the gap was
   * accepted here and fired on arrival. `stopLossBounds` is the same band-plus-
   * margin treatment `takeProfitBounds` already got after that cost $1.58 on a
   * $50 stake, measured.
   */
  const slBounds = quote?.ok ? stopLossBounds(quote) : null;
  const slTooNear = !!(slBounds && sl12 > BigInt(0)
    && (sl12 < slBounds.minPrice12 || sl12 > slBounds.maxPrice12));
  const slValid = !!(slBounds && sl12 > BigInt(0) && !slTooNear);
  /**
   * A WARNING, never a refusal.
   *
   * A long's stop at or below the liquidation price can never fire — the
   * position is gone first — so the protection is decorative. But the
   * liquidation price moves with funding, and a user may well want a stop only
   * reachable after it drifts. Say so; do not decide for them.
   */
  const slPastLiquidation = !!(slValid && quote?.ok
    // Inlined rather than reusing `liquidatable`, which is declared below: PEX
    // signals "cannot be liquidated" with a zero price and an empty direction,
    // and treating that zero as a real price would warn on every position that
    // has no liquidation at all.
    && quote.liquidationDirection !== "" && quote.liquidationPrice12 > BigInt(0)
    && (side === "long"
      ? sl12 <= quote.liquidationPrice12
      : sl12 >= quote.liquidationPrice12));

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
  // The cleanup matters: without it a card that unmounts mid-signature leaves
  // the parent's `busy` true, and the market toggle stays disabled for good.
  useEffect(() => {
    onBusyChange?.(submitting);
    return () => onBusyChange?.(false);
  }, [submitting, onBusyChange]);

  /**
   * What this signature actually moves, derived rather than written out.
   *
   * ── Why it is computed ──────────────────────────────────────────────────────
   * The prose version keyed on `tpEmpty` alone and was wrong for a targetless
   * LIMIT order: a limit entry always escrows a keeper fee and always pays a
   * 100,200 µALGO order-box MBR, whether or not a take-profit rides along. So
   * the line said "collateral only, ~0.03 ALGO" where the truth was collateral
   * plus $0.10 plus ~0.12 ALGO — understated, on the one line in the product
   * that enumerates what leaves the wallet, directly above a sentence telling
   * the user their money is being escrowed.
   *
   * That was a regression introduced while fixing the targetless-MARKET case,
   * which is exactly what hand-written prose over four combinations invites.
   * Deriving it from the same constants the client bills against means the text
   * cannot drift from the group again.
   *
   * ── The fee figures ───────────────────────────────────────────────────────
   * Group fee totals observed on real MainNet groups:
   *
   *   market, no target     34,000 µALGO   (twice, two different accounts)
   *   market with target    51,000         + 99,700 order box
   *   limit, no target      18,000         + 100,200 order box
   *   limit with target     36,000         + 100,200 + 99,700
   *
   * Audit 9 LOW 5: this comment previously claimed 20,000 for a bare limit and
   * called the set "measured". The measured value is 18,000. These are also not
   * constants — the total is per-transaction minFee times the transaction count,
   * and the carrier count varies with resource packing, so treat them as the
   * observed figure rounded for display. The line says "about" and errs high,
   * which is the safe direction for a disclosure; claiming measurement it did
   * not have is the part that needed fixing.
   */
  /**
   * Is the quote good enough to show and to sign against?
   *
   * `quote.ok` for a market order. For a LIMIT order, also a quote that failed
   * only because the market has no room right now: its numbers are real, and
   * "cannot open this instant" is not a claim a resting order makes. Without
   * this the bar and the ceiling widened for limit orders and `canSubmit` then
   * refused every size they offered — audit 10 HIGH 3.
   */
  const quoteUsable = !!quote?.ok || (isLimit && capacityOnlyFailure(quote));

  /** 0, 1 or 2 protective orders. Every per-order cost keys off this. */
  /**
   * Protective legs this entry will actually carry.
   *
   * `!isLimit` on the stop-loss term, because `openLimitOrder` has no
   * `stopLossPrice12` — the limit path is stage two. Without the term the card
   * charged a limit order for a second keeper fee and a second 99,700 µALGO box
   * that its group never creates, and offered a stop it then discarded.
   */
  const legCount = (tpEmpty ? 0 : 1) + (slEmpty ? 0 : 1);
  const moves = useMemo(() => {
    /**
     * Fees by (entry kind, leg count).
     *
     * The two-leg market figure was 53,000, described as the one-leg figure plus
     * "the per-transaction minimum for the extra submit and its carrier… it errs
     * high". It errred LOW by 15,000: the OrderOps submit is 14,000, a flat
     * protocol fee (`V2_ORDER_OPS_METHOD_FLAT_FEE_MICRO_ALGO`), not a 1,000
     * minimum. Derived from the captured fixture rather than guessed: 51,000
     * one-leg + 14,000 submit + 1,000 escrow + 1,000 MBR + 1,000 for the extra
     * Math carrier a second child forces = 68,000.
     *
     * Unreachable today — the card allows one leg at a time — but a wrong number
     * waiting behind a flag is still a wrong number, and understating what leaves
     * the wallet is the exact regression audit 8 recorded.
     */
    const feeMicro = isLimit
      ? (legCount === 0 ? 18_000 : 36_000)
      : (legCount === 0 ? 34_000 : legCount === 1 ? 51_000 : 68_000);
    /**
     * One box per resting order. A market open creates one only for its
     * take-profit; a limit entry creates its own, plus the child's.
     *
     * Audit 9 MEDIUM 3: these were the literals 100_200 and 99_700, under a
     * comment claiming the figures were derived from the constants the client
     * bills against. They were not — so the drift this was written to close was
     * still open, behind a comment saying it was shut. Imported now, converted
     * at the point of use because the constants are bigint and this arithmetic
     * is in number.
     */
    const boxMicro = (isLimit ? Number(LIMIT_ORDER_BOX_MBR_MICRO_ALGO) : 0)
      + legCount * Number(ORDER_BOX_MBR_MICRO_ALGO);
    // The keeper fee is escrowed per resting order, for the same reason.
    const keeperCount = (isLimit ? 1 : 0) + legCount;
    /**
     * A DIFFERENT quantity that happens to equal the limit order-box MBR: the
     * one-off storage escrow a first-time trader funds.
     *
     * It gets its own constant rather than sharing the order-box import, so a
     * change to one cannot silently move the other — but it is still an IMPORT.
     * Review caught this left as the literal `100_200` under a comment arguing
     * for the separation, which conflated "separate quantity" with "hard-code
     * it": the right constant already existed in the module this file now
     * imports from, and it is the same one `assertOpenGroup` checks the storage
     * payment against. It is derived from the SDK's
     * `V2_OPEN_ORDER_EXECUTION_STORAGE_ESCROW_MICRO_ALGO`, so it tracks PEX.
     *
     * That is the audit-9 MEDIUM 3 defect re-created inside its own fix, which
     * is why the comment is kept rather than tidied away.
     */
    const firstTradeExtra = Number(STORAGE_ESCROW_MICRO_ALGO);
    return {
      keeperUsd: keeperCount * CHILD_KEEPER_FEE_USDC,
      algo: (feeMicro + boxMicro) / 1e6,
      algoFirstTrade: (feeMicro + boxMicro + firstTradeExtra) / 1e6,
    };
  }, [isLimit, legCount]);

  /**
   * Limit mode, and this size could not open right now.
   *
   * The order is still placeable — that is the fix — but it rests until the
   * market has room, and the card says so rather than letting a user discover
   * it as an order that never fills.
   */
  const waitsForRoom = !!(capacityNow && notional > capacityNow.maxNotionalUsd);

  const [frozen, setFrozen] = useState<CardSnapshot | null>(null);

  /**
   * Everything the card displays, in one object.
   *
   * Audit 7 found the freeze was **partial**: four values were captured and six
   * more derived flags — `liquidatable`, `tradable`, `tpValid`, `tpPayoff`,
   * `ceilingUsd`, `indexUsd` — were still read live at the render sites. One
   * failed ten-second refresh during a prompt collapses
   * `dataTrusted → tradable → notional → quote → liquidatable`, and the card,
   * still rendering the FROZEN quote, printed "Liquidation: None — it cannot be
   * liquidated" over a leveraged position being approved at that moment. The
   * mirror case rendered `$0.000000` as a liquidation price, which is the H2
   * defect the comment block above `liquidatable` says was fixed.
   *
   * Assembling it rather than patching six call sites is the point. The
   * invariant is now mechanical: **the JSX reads `view.*` and never a live
   * derived value**, so a field added later is frozen by default instead of
   * being the next thing an audit finds.
   */
  const live: CardSnapshot = {
    quote, notional, collateralUsd, tpPrice, tradable, liquidatable, tpValid, tpPayoff,
    quoteUsable,
    slPrice, slEmpty, slValid, slTooNear, slPastLiquidation,
    ceilingUsd, indexUsd, quickPick, chipPicks, isLimit, trigger12, funding, tpEmpty, moves,
    openInterest,
    waitsForRoom,
    minLeverage: bar?.open ? bar.minLeverage : null,
    binding: bar?.open ? bar.binding : null,
  };
  /** What the card renders. The live values keep updating underneath. */
  const view = frozen ?? live;
  /**
   * Everything required to sign, all of it already true for `tradable`, plus a
   * connected wallet and a valid target.
   */
  /**
   * A limit trigger that is already crossed would fill immediately, which is a
   * worse market order — the user pays a keeper fee and a box MBR for an
   * execution the market button does in one group at the same price.
   * `openLimitOrder` refuses it; the button refuses it first, so the user is
   * told before they click rather than after.
   */
  const triggerCrossed = !!(isLimit && trigger12 > BigInt(0) && indexUsd !== null
    && (side === "long"
      ? trigger12 >= usdToPrice12(String(indexUsd))! 
      : trigger12 <= usdToPrice12(String(indexUsd))!));
  const triggerReady = !isLimit || (trigger12 > BigInt(0) && !triggerCrossed);

  /**
   * No take-profit is now a choice, not an incomplete form.
   *
   * It was mandatory because, with no close path, it was the only exit a
   * position had — omitting it meant liquidation was the sole outcome. Closing
   * is built, so a target is optional again, which is what letting a leveraged
   * position run on momentum requires.
   *
   * A target that is TYPED but invalid still blocks: that is a half-finished
   * input, not a decision.
   */
  const tpOk = tpEmpty || tpValid;
  // Same rule: no stop-loss is fine, a stop-loss on the wrong side is not.
  // A stop-loss cannot block a LIMIT entry, which never carries one.
  /**
   * One protective leg at a time — see `PROTECTION_ENABLED`.
   *
   * Not a technical limit: the group, the assertion and the shapes all handle
   * two. It is the flag's own precondition, which is about OCO — whether PEX
   * removes the sibling when one leg executes. With a single leg there is no
   * sibling, so the question does not arise and the precondition is satisfied
   * rather than waived.
   */
  const bothLegs = !tpEmpty && !slEmpty;
  const slOk = (slEmpty || slValid) && !bothLegs;

  const canSubmit = !!(
    tradable && tpOk && slOk && quoteUsable && !submitting && triggerReady
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
    setFrozen(live);
    try {
      const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");
      if (isLimit) {
        // A separate call, not a flag on this one. The two build different
        // groups, assert against different shapes and have different failure
        // modes; sharing an entry point would mean one function whose meaning
        // depends on a boolean, on the money path.
        //
        // No `displayed` block: a limit entry has no quoted entry or
        // liquidation price to drift against — the trigger and its bound are
        // both the user's own input. See `openLimitOrder`.
        const rl = await openLimitOrder({
          algod,
          signTransactions: (txns) => wallet.signTransactions(txns),
          sender: wallet.address,
          marketId, side,
          collateralUsd,
          notionalUsd: notional,
          triggerPrice12: trigger12,
          ...(tp12 > BigInt(0) ? { takeProfitPrice12: tp12 } : {}),
          /**
           * Audit 10 SB2: this was missing.
           *
           * The stop-loss input was un-gated for limit mode, validated, and
           * billed for in the disclosure — and the value never reached
           * `openLimitOrder`, so a bare limit order was built and asserted
           * green. The card said "capping the loss" and charged $0.20 in keeper
           * fees over a group carrying one keeper fee and no stop.
           *
           * Zero is "none" on both paths now; see the contract note in
           * `openLimitOrderInner`, which had to be aligned FIRST or this exact
           * line would have refused every limit order.
           */
          ...(sl12 > BigInt(0) ? { stopLossPrice12: sl12 } : {}),
          slippageBps: DEFAULT_SLIPPAGE_BPS,
          onStage: setStage,
        });
        setResult(rl);
        return;
      }
      const r = await openPosition({
        algod,
        signTransactions: (txns) => wallet.signTransactions(txns),
        sender: wallet.address,
        marketId,
        side,
        collateralUsd,
        notionalUsd: notional,
        takeProfitPrice12: tp12,
        stopLossPrice12: slEmpty ? BigInt(0) : sl12,
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
      {/* Market label left, order type centred, price right. `flex-1` on the
          middle group centres it against the card rather than against the gap,
          so it holds position as the label and price change width — the same
          arrangement the chart panel uses for Basic/Advanced. */}
      <div className="flex items-center gap-3">
        <span className="font-display text-base font-semibold text-white">{market.label}</span>

        <div className="flex flex-1 justify-center">
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1">
            {([["market", "Market", "Fills now, at the current price"],
               ["limit", "Limit", "Rests until the price reaches your trigger"]] as const).map(([m, text, title]) => (
              <button key={m} type="button" disabled={submitting} title={title}
                onClick={() => { setMode(m); setTriggerPrice(""); setTpPct(null); setTpPrice(""); setSlPrice(""); }}
                className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${
                  mode === m ? "bg-magnet-500/20 text-white" : "text-white/45 hover:text-white/75"}`}>
                {text}
              </button>
            ))}
          </div>
        </div>

        <span className="text-xs tabular-nums text-white/45">
          {/* `view.indexUsd`, not `indexUsd`. Review caught this as the one
              field already IN the snapshot that was still read live at a second
              site — precisely the "seventh site" the structural fix was meant
              to make impossible. It is also the value passed as
              `asRenderedIndexPrice12`, so a live read here meant the header
              stopped showing the number the drift guard guards. */}
          {view.indexUsd !== null ? fmtPrice(view.indexUsd) : loading ? "…" : ""}
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

      {/* ── Open interest ──────────────────────────────────────────────────
          A market fact, so it sits with the market and not inside the order.
          The first version lived in the third column beside leverage and
          funding, where it was true, live, and never found: the reader who
          asked whether we showed open interest at all had it on screen.

          The second version showed BOTH sides under one "Open interest"
          heading, and that conflated two quantities — the open interest is the
          dollar figure, the percentage is that figure against the cap.

          Now titled for the constraint rather than the quantity: "OI headroom"
          is what PEX is actually enforcing, and capping trades on open interest
          is PEX's own design choice, not a universal of perps. The leading
          figure is the utilisation, because "98.9% used" is the fact a trader
          acts on. The side is not named: it is whichever the toggle is set to,
          and the binding note below names it in words when it actually bites.

          Zero is spelled out rather than drawn as an empty bar and left to be
          guessed at. Three separate things on this card have now been reported
          missing when they were in fact zero. */}
      {view.openInterest && (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3">
          {/* Stacked, not side by side. Across one line the label and the
              figures each wrapped to two at phone width, which rendering caught
              and reading would not have. */}
          <p className="text-[11px] uppercase tracking-wider text-gray-500">OI headroom</p>
          <p className="mb-1.5 mt-0.5 font-mono text-[11px] tabular-nums text-gray-300">
            {view.openInterest.usedUsd <= 0 ? (
              <>0% used<span className="text-white/30"> — nothing open on this side yet</span></>
            ) : (
              <>
                {view.openInterest.pct.toFixed(1)}% used
                <span className="text-white/30">
                  {" "}· {fmtUsd(view.openInterest.usedUsd)} of {fmtUsd(view.openInterest.capUsd)}
                </span>
              </>
            )}
          </p>
          {/* Same thresholds and geometry as the Bank's utilisation bars, so a
              full book looks the same in both products. The track stays visible
              at zero: an empty bar is the picture of "room available", which is
              the one thing a missing bar cannot say. */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full transition-all duration-700 ${
                view.openInterest.pct > 80 ? "bg-red-500"
                  : view.openInterest.pct > 60 ? "bg-yellow-500"
                  : "bg-magnet-500"}`}
              style={{ width: `${Math.min(view.openInterest.pct, 100)}%` }}
            />
          </div>
          {view.openInterest.usedUsd <= 0 && (
            <p className="mt-1 text-[11px] text-white/35">
              The whole {fmtUsd(view.openInterest.capUsd)} cap is free on this side.
            </p>
          )}
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

      {view.isLimit && (
        <div className="mt-4">
          <label htmlFor="perps-trigger" className="text-xs font-medium uppercase tracking-wide text-white/50">
            Fill at
          </label>
          <div className="mt-1.5 flex items-center rounded-xl border border-white/10 bg-black/40 px-3">
            <span className="text-white/40">$</span>
            <input id="perps-trigger" inputMode="decimal" value={triggerPrice}
              placeholder={indexUsd !== null ? fmtPrice(indexUsd).replace("$", "") : ""}
              disabled={submitting}
              onChange={(e) => {
                // Same whitelist the amount and take-profit inputs use: a
                // rejected keystroke reports why rather than being swallowed.
                const v = readNumericInput(e.target.value);
                if (!v.ok) { setTriggerHint(v.hint); return; }
                setTriggerHint(null);
                setTriggerPrice(v.value);
              }}
              className="w-full bg-transparent px-2 py-3 font-semibold tabular-nums text-white outline-none disabled:opacity-50" />
          </div>
          {triggerHint && <p className="mt-1 text-xs text-amber-300/90">{triggerHint}</p>}
          {/* The one thing that makes a limit order wrong before it is placed. */}
          {triggerCrossed ? (
            <p className="mt-1 text-xs text-amber-300/90">
              {side === "long"
                ? "That is at or above the current price, so it would fill straight away — use Market, or set a lower price."
                : "That is at or below the current price, so it would fill straight away — use Market, or set a higher price."}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-white/35">
              Your order rests until {market.label.split("/")[0]} reaches this price. Nothing is
              traded until then, and you can cancel before it fills.
            </p>
          )}
        </div>
      )}

      {/* Risk */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-white/50">Risk</span>
          <span className="text-sm font-semibold tabular-nums text-white">
            {view.tradable && view.quoteUsable && view.quote ? `${view.quote.leverage.toFixed(2)}×` : "—"}
          </span>
        </div>
        <input id="perps-risk" type="range" min={0} max={1} step={0.01} value={barPos}
          disabled={!tradable || submitting}
          onChange={(e) => setBarPos(Number(e.target.value))}
          className="mt-2 w-full accent-magnet-400 disabled:opacity-30" />
        <div className="flex justify-between text-[11px] tabular-nums text-white/40">
          <span>{view.tradable && view.minLeverage !== null ? `${view.minLeverage.toFixed(2)}×` : ""}</span>
          <span>{view.tradable && view.collateralUsd > 0 ? `${(view.ceilingUsd / view.collateralUsd).toFixed(2)}×` : ""}</span>
        </div>
        {collateralUsd <= 0 && (
          <p className="mt-1 text-xs text-white/40">
            Enter an amount above to see your size, leverage and liquidation price.
          </p>
        )}
        {/* ── Why these three are gated on `!frozen` ──────────────────────
            All three are advice derived from live `bar` / `tradable`, and all
            three could turn on mid-prompt underneath a frozen quote. Review's
            case: a refresh lands in which OI headroom has shrunk, `tradable`
            goes false with `bar.open` still true, and the card prints "No size
            on this side currently clears the exchange's checks. Try a different
            amount." directly beneath "Position size $174.78" while the user is
            approving that position. Frozen numbers with live prose is the same
            contradiction the `liquidatable` ship-blocker was.
            Suppressed rather than snapshotted: advice is only actionable when
            the user can act, and while the wallet is open they cannot. */}
        {!frozen && bar && !bar.open && (
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
        {!frozen && bar?.open && !tradable && preflight.canOpen === null && (
          <p className="mt-1 text-xs text-white/45">Verifying the exchange contracts…</p>
        )}
        {!frozen && bar?.open && !tradable && preflight.canOpen === true && dataTrusted && (
          <p className="mt-1 text-xs text-amber-300/90">
            No size on this side currently clears the exchange&apos;s checks. Try a different amount.
          </p>
        )}
        {view.tradable && view.binding && (
          <p className="mt-1 text-[11px] text-white/35">
            Position size {fmtUsd(view.notional)} · limited by{" "}
            {BINDING_LABEL[view.binding] ?? view.binding.replace(/_/g, " ")}
          </p>
        )}
        {/* When the MARKET is the cap, say so and say what to do about it.
            A squeezed-but-open book previously showed only the raw enum: the
            plain-English "at its size limit" line fires when the bar is CLOSED,
            which is not the case that confused anyone. A long capped at 1.1x
            looks broken; a long capped at 1.1x BECAUSE the book is nearly full
            is information. Two separate reports read a correct number as a bug
            before this line existed. */}
        {view.tradable && (view.binding === "oi_headroom" || view.binding === "reserves") && (
          <p className="mt-1 text-[11px] text-amber-300/80">
            Not your limit — the {side} side of this market is nearly full right
            now, so this is the largest position it can take. The other side and
            the other market are usually unaffected, and a limit order can rest
            until room opens up.
          </p>
        )}
        {/* Funding, as a direction and a rate — the thing that actually
            changes whether this side is worth being on. */}
        {view.funding && !view.funding.charged && (
          <p className="mt-1 text-[11px] leading-relaxed text-white/35">
            <span className="text-white/55">No funding is being charged here right now</span> —
            neither side is paying the other. It moves with the market; on this market the
            paying side&apos;s rate can reach about {view.funding.ceilingPct.toFixed(0)}% a year.
          </p>
        )}
        {view.funding?.charged && (
          <p className="mt-1 text-[11px] leading-relaxed text-white/35">
            {view.funding.youPay ? (
              <>
                <span className="text-amber-300/80">
                  Holding this side costs about {view.funding.annualPct.toFixed(0)}% a year
                </span>{" "}
                in funding, paid continuously to the other side while the position is open.
              </>
            ) : (
              <>
                <span className="text-green-300/80">Funding is in your favour here</span> — the
                other side is paying about {view.funding.annualPct.toFixed(0)}% a year, and you
                receive a share of it. Both the rate and the direction move with the market.
              </>
            )}
          </p>
        )}
      </div>

      </div>

      <div>
      {/* Liquidation — permanent, not a disclosure the user can dismiss */}
      <div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/[0.07] px-3.5 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-red-300/80">
            Liquidation{view.isLimit && view.trigger12 > BigInt(0) ? " if filled" : ""}
          </span>
          <span className="text-base font-bold tabular-nums text-red-300">
            {!view.quoteUsable || !view.quote ? "—" : view.liquidatable ? fmtPrice(price12ToUsd(view.quote.liquidationPrice12)) : "None"}
          </span>
        </div>
        {view.quoteUsable && view.liquidatable && view.indexUsd !== null && (
          <p className="mt-0.5 text-[11px] text-red-200/60">
            {side === "long" ? "Falls to" : "Rises to"} this and the position closes at a total loss of {fmtUsd(view.collateralUsd)}
            {/* Measured from the price this order is relative to: the LIVE
                index for a market order, which is where the user is now, and
                the ENTRY for a limit order, which is where they would be.
                Mixing them — a trigger-based liquidation against a live index —
                would be a number describing neither.

                Either way the distance is exact, including for a limit order:
                liquidation scales with entry, so the ratio between them does
                not depend on where the order fills. Measured identical at spot
                and at trigger on both sides. The conditional part of a limit
                quote is the two PRICES, not this. */}
            {" · "}{(() => {
              const liq = price12ToUsd(view.quote!.liquidationPrice12);
              const ref = view.isLimit ? price12ToUsd(view.quote!.entryPrice12) : view.indexUsd!;
              return (Math.abs(liq - ref) / ref * 100).toFixed(1);
            })()}% away
          </p>
        )}
        {view.quoteUsable && !view.liquidatable && (
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
              // The SAME function that writes the price decides whether the
              // chip is offered. Audit 7: these were two expressions of one
              // rule, and only the writing half knew about the move bound, so a
              // chip stayed lit over a target it would not stand behind.
              //
              // Resolved off `chipPicks`, which is memoised and frozen with the
              // rest while signing — so the chips cannot grey out and contradict
              // the payoff line above them mid-prompt, and the rule is not
              // recomputed three times per render.
              const pick = view.chipPicks[pct] ?? null;
              const reachable = !pick || pick.ok;
              // `!reachable` does not disable a SELECTED chip. It used to, and
              // since the `on` styling won over the `!reachable` styling the
              // chip sat green-as-selected while unclickable — so the one
              // gesture that clears it did nothing. Clearing a bad selection
              // must always stay reachable; it shows amber instead.
              return (
                <button key={pct} type="button" disabled={submitting || (!reachable && !on)}
                  onClick={() => setTpPct(on ? null : pct)}
                  title={
                    !pick || pick.ok ? undefined
                    : pick.reason === "unpayable"
                      ? "This position cannot make that much"
                      : `Needs a ${(pick.moveBps! / 100).toFixed(0)}% price move at this risk level`
                  }
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    on && !reachable ? "bg-amber-500/20 text-amber-200"
                      : on ? "bg-green-500/20 text-green-200"
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
        {/* A refused chip says what it refused and what fixes it. Silence here
            is what let "+50%" sit lit over a target needing a 500% move. */}
        {view.quickPick && !view.quickPick.ok && (
          <p className="mt-1 text-xs text-amber-300/90">
            {view.quickPick.reason === "unpayable"
              ? "This position cannot make that much profit at any price."
              : `That target needs a ${(view.quickPick.moveBps! / 100).toFixed(0)}% price move at this risk level. Raise the risk level, or pick a smaller target.`}
          </p>
        )}
        {view.quoteUsable && view.tpEmpty ? (
          /* Not an error. The consequence, stated once, without nagging. */
          <p className="mt-1 text-xs text-white/40">
            No target set — this position runs until you close it, or until it
            liquidates. You can add a target later by closing and reopening.
          </p>
        ) : view.quoteUsable && (
          view.tpValid && view.tpPayoff !== null ? (
            <p className="mt-1 text-xs text-green-300/90">
              Closes for {fmtUsd(view.tpPayoff)} profit before costs
              {view.quickPick?.ok && ` · a ${(view.quickPick.moveBps / 100).toFixed(1)}% price move`}
              {/* The chip reads "+10%" but the written price is not +10%: the
                  crossing guard moved it. The profit above is computed from the
                  price actually written, so it is right — the LABEL is what
                  would otherwise mislead. */}
              {view.quickPick?.ok && view.quickPick.clamped
                && ", nudged out of the no-fill zone next to the current price"}
            </p>
          ) : (
            <p className="mt-1 text-xs text-amber-300/90">
              {/* Empty is now the starting state, so it gets its own line —
                  "choose a target above $X" reads as a correction for a number
                  the user has not entered yet. */}
              {view.tpPrice.trim() === ""
                ? "Pick a profit target above, or type an exit price. A target closes it automatically if the price gets there."
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

      {view.waitsForRoom && (
        /* Honest about what letting a limit order past the capacity check means:
           placeable now, fillable when the market has room. */
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This market is at its size limit on the {side} side right now, so this
            order will rest until there is room. It can still be placed — it fills
            when your price and the capacity are both there — but it will not fill
            the moment your price is hit if the market is still full.
          </span>
        </div>
      )}

      {/* Protection — the stop-loss. Optional, like the take-profit above. */}
      {PROTECTION_ENABLED ? (
        <label className="mt-4 block">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Stop loss <span className="normal-case tracking-normal text-white/30">· optional</span>
          </span>
          <div className="mt-1.5 flex items-center rounded-xl border border-white/10 bg-black/40 px-3">
            <span className="text-white/40">$</span>
            <input id="perps-sl" inputMode="decimal" value={view.slPrice}
              onChange={(e) => {
                const v = readNumericInput(e.target.value);
                if (!v.ok) { setSlHint(v.hint); return; }
                setSlHint(null);
                setSlPrice(v.value);
              }}
              disabled={submitting}
              className="w-full bg-transparent px-2 py-3 font-semibold tabular-nums text-white outline-none disabled:opacity-50" />
          </div>
          {slHint && <p className="mt-1 text-xs text-amber-300/90">{slHint}</p>}
          {view.slEmpty ? (
            /* The consequence, stated once, without nagging — the same treatment
               the take-profit's empty state gets. */
            <p className="mt-1 text-xs text-white/40">
              No stop set — nothing closes this position early if the price moves
              against you. Liquidation is the only floor.
            </p>
          ) : view.slTooNear ? (
            <p className="mt-1 text-xs text-amber-300/90">
              {side === "long"
                ? "That stop is too close to the current price — it would trigger the moment the position opened, closing it straight away for a loss in fees. Move it further below."
                : "That stop is too close to the current price — it would trigger the moment the position opened, closing it straight away for a loss in fees. Move it further above."}
            </p>
          ) : view.slPastLiquidation ? (
            /* A warning, not a refusal: the liquidation price moves with funding,
               so a stop beyond it today may be reachable tomorrow. Saying so is
               the honest version; deciding for them is not. */
            <p className="mt-1 text-xs text-amber-300/90">
              This stop sits past the liquidation price, so the position would be
              liquidated before it could fire. Still allowed — liquidation moves
              with funding — but it protects nothing today.
            </p>
          ) : view.slValid ? (
            <p className="mt-1 text-xs text-white/40">
              Closes automatically if the price reaches this, capping the loss. Costs
              a second keeper fee and a second order record — both are in the line
              below.
            </p>
          ) : null}
        </label>
      ) : (
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
      {view.quoteUsable && view.quote && (
        <dl className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-xs">
          {[
            [view.isLimit ? "Entry price if filled" : "Entry price",
              fmtPrice(price12ToUsd(view.quote.entryPrice12))],
            /**
             * One line, one number.
             *
             * Two rows asked the reader to add them up to learn what opening
             * costs, which is the only figure that changes a trade decision.
             * The split between the venue's fee and ours is not a fact about
             * their trade, so it is not on the trade screen; it stays in
             * `PerpsInfoModal`, which states our 10 bps explicitly, and in the
             * PEX attribution under the button.
             *
             * "Charged again on close" stays, because that IS about their cost:
             * a round trip is roughly double what this line shows.
             */
            ["Fees (charged again on close)",
              fmtUsd(view.quote.openFeeUsd + view.quote.builderFeeUsd)],
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
          {submitting ? STAGE_LABEL[stage]
            : view.isLimit
              // Says what actually happens. "Open long" over a resting order
              // would promise a position the click does not create.
              ? `Place ${side} limit · ${fmtUsd(view.notional)}`
              : `Open ${side} · ${fmtUsd(view.notional)}`}
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
          One signature. {fmtUsd(view.collateralUsd)} collateral
          {view.moves.keeperUsd > 0 && <> and {fmtUsd(view.moves.keeperUsd)} keeper
            fee{view.moves.keeperUsd > CHILD_KEEPER_FEE_USDC ? "s" : ""}</>}
          {" "}leave{view.moves.keeperUsd > 0 ? "" : "s"} your wallet, plus about{" "}
          {view.moves.algo.toFixed(2)} ALGO
          {view.moves.algo > 0.04 ? " in network fees and the on-chain order record" : " in network fees"}
          {" "}— or {view.moves.algoFirstTrade.toFixed(2)} on your first PEX trade, which also sets
          up a storage record PEX keeps.
          {view.isLimit && (
            // The part that is genuinely different: nothing is traded on this
            // signature, and the money is escrowed until it fills or is
            // cancelled. Said before the prompt, not discovered after.
            <> {" "}Nothing is traded yet — this places a resting order, and the
            money stays escrowed with PEX until it fills or you cancel it.</>
          )}
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
