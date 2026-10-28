/**
 * What a liquidity deposit or withdrawal actually does, quoted before it is built.
 *
 * The numbers here are what the confirm screen shows and what
 * `strategy/group.ts` then asserts the signed bytes against. They come from the
 * SDK's contract-path quotes (`preview_source: "sdk_v2_contract_path"`) priced
 * off the SIGNED oracle bytes — never off a mid-price we picked, and never off
 * the unsigned performance bundle.
 *
 * Measured on market 1, 2026-10-21:
 *
 *   deposit  0.5 ALGO + 0.5 USDC  ->  0.492229 shares, $0.557051, impact −$0.000572
 *   withdraw 0.092902 shares      ->  0.230900 ALGO + 0.078579 USDC, $0.104929
 */

import algosdk from "algosdk";
import { quoteV2LpDeposit, quoteV2LpWithdraw } from "@pdex/sdk";
import {
  readMarketState, readYieldRegistry, readMarketPositions,
  type MarketState, type PositionState,
} from "@/lib/strategy/pex/reads";
import { marketRecord, priceInput } from "@/lib/strategy/pex/quote";
import { getOraclePayload, type OraclePayload } from "@/lib/strategy/pex/oracle";
import { PEX_APPS, PEX_ASSETS } from "@/lib/strategy/pex/config";
import { installProtocolManifest } from "@/lib/strategy/pex/manifest";

export type DepositQuote = {
  ok: boolean;
  failureReasons: string[];
  /** Pool shares the deposit mints, micro. */
  sharesOut: bigint;
  /** What the deposit is worth, µUSD. */
  valueUsd: bigint;
  /**
   * Price impact, µUSD — NEGATIVE means the deposit is worth less than the sum
   * of its parts, which is the usual case when it arrives off the pool's ratio.
   */
  impactUsd: bigint;
  feeAmount: bigint;
  requiredFeeMicroAlgo: bigint;
};

export type WithdrawQuote = {
  ok: boolean;
  failureReasons: string[];
  /** µALGO paid out. */
  algoOut: bigint;
  /** µUSDC paid out. */
  usdcOut: bigint;
  valueUsd: bigint;
  feeUsd: bigint;
  requiredFeeMicroAlgo: bigint;
};

const bigOf = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return BigInt(0);
};
const reasons = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : [];

/** Market state and a verified price, read once and shared by both quotes. */
export type QuoteContext = {
  marketId: number;
  state: MarketState;
  oracle: OraclePayload;
  prices: Record<string, bigint>;
  market: Record<string, bigint>;
  /**
   * Every open position in the market.
   *
   * Not optional, and not a refinement: without these the quotes price the pool
   * at its balances and ignore trader P&L, which is the term that decides what
   * a share is worth. See `readMarketPositions`.
   */
  positions: PositionState[];
};

export async function readQuoteContext(
  algod: algosdk.Algodv2, marketId: number,
): Promise<QuoteContext> {
  await installProtocolManifest();
  const [state, oracle, positions] = await Promise.all([
    readMarketState(algod, marketId),
    // AdminOps, because AdminOps is the app that will verify this payload — the
    // signed bundle's own key is `app-3690309162/market-N`.
    getOraclePayload(PEX_APPS.adminOps, marketId),
    readMarketPositions(algod, marketId),
  ]);
  if (!oracle.signatureVerified) {
    throw new Error("The price could not be verified against PEX's signing key.");
  }
  return {
    marketId, state, oracle, positions,
    prices: priceInput(oracle),
    market: marketRecord(state),
  };
}

export function quoteDeposit(
  ctx: QuoteContext, algoMicro: bigint, usdcMicro: bigint,
): DepositQuote {
  const q = quoteV2LpDeposit({
    market: ctx.market as never,
    pool: ctx.state.pool as never,
    longAmount: algoMicro,
    shortAmount: usdcMicro,
    prices: ctx.prices as never,
    positions: ctx.positions as never,
  }) as unknown as Record<string, unknown>;
  return {
    ok: q.ok === true,
    failureReasons: reasons(q.failure_reasons),
    sharesOut: bigOf(q.market_shares_out),
    valueUsd: bigOf(q.deposit_value_usd),
    impactUsd: bigOf(q.impact_usd),
    feeAmount: bigOf(q.fee_amount),
    requiredFeeMicroAlgo: bigOf(q.required_flat_fee_microalgos),
  };
}

export function quoteWithdraw(ctx: QuoteContext, shareAmount: bigint): WithdrawQuote {
  const q = quoteV2LpWithdraw({
    market: ctx.market as never,
    pool: ctx.state.pool as never,
    shareAmount,
    prices: ctx.prices as never,
    positions: ctx.positions as never,
  }) as unknown as Record<string, unknown>;
  return {
    ok: q.ok === true,
    failureReasons: reasons(q.failure_reasons),
    algoOut: bigOf(q.long_amount_out),
    usdcOut: bigOf(q.short_amount_out),
    valueUsd: bigOf(q.withdrawal_value_usd),
    feeUsd: bigOf(q.withdrawal_fee_usd),
    requiredFeeMicroAlgo: bigOf(q.required_flat_fee_microalgos),
  };
}

/**
 * Default slippage tolerance.
 *
 * ── There is deliberately no `floorOf` here ──
 * An earlier revision exported one, and it was a trap: the on-chain floors must
 * NOT be derived from these quotes. `quoteV2LpDeposit` is ~1.65% high on shares
 * and `quoteV2LpWithdraw` ~1.6% low on both payouts, so a 1% floor taken from
 * the deposit quote is unsatisfiable and MainNet rejects the group at
 * `AdminOps pc=1541`. The floors come from the contract's own simulated
 * receipt — `withTolerance` in `strategy/group.ts` — and these quotes are only
 * a fast estimate to show while someone is typing.
 */
export const DEFAULT_LIQUIDITY_SLIPPAGE_BPS = 100;

/**
 * Yield-recall inputs for a withdrawal.
 *
 * Read from chain rather than fetched from Ultrade's API, exactly as the close
 * path does — see `readYieldRegistry`.
 *
 * ── Why a withdrawal needs a recall at all ──
 * The pool's assets are deployed into yield (xALGO, Folks), so there is usually
 * not enough idle to pay an exit from. Measured: `yieldRecallMode: 0` builds
 * fine and then fails inside the Markets app at `inner tx 0`. Ultrade's own
 * guidance is to always recall. With caps at zero the SDK builds a group that
 * MainNet then rejects at a `<=` assert — which is how the caps below were
 * found to be mandatory rather than optional.
 */
export type RecallContext = {
  /** Passed to the SDK builder as `marketYieldRegistry`. */
  registry: Record<string, unknown>;
  /**
   * The closed set of accounts, assets and apps the recall may reference.
   *
   * Returned together with the registry on purpose: the group assertion needs
   * both, and a caller that read one without the other would either refuse
   * every correct withdrawal or allow resources nothing vouched for.
   */
  recall: { accounts: string[]; assets: number[]; apps: number[] };
};

export async function readRecallContext(
  algod: algosdk.Algodv2, ctx: QuoteContext,
): Promise<RecallContext> {
  const reg = await readYieldRegistry(
    algod, ctx.marketId, PEX_ASSETS.usdc, Number(ctx.state.core.index_asset_id),
  );
  return {
    registry: reg as unknown as Record<string, unknown>,
    recall: reg.recall,
  };
}

/**
 * Receipt caps for a withdrawal's recall.
 *
 * ── A unit note, because it is easy to state this wrongly ──
 * These args cap RECEIPT tokens (xALGO, fUSDC); the quote's outputs are
 * denominated in the UNDERLYING (ALGO, USDC). Receipts appreciate against
 * underlying, so a cap set from the underlying payout comes out GENEROUS rather
 * than tight. That is safe in the only direction a cap can be — it is a maximum
 * — and it is the same choice the close path makes, for the same reason.
 */
export const recallCaps = (q: WithdrawQuote) => ({
  long: q.algoOut,
  short: q.usdcOut,
});
