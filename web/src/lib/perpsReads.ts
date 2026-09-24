// Perps — read-only on-chain queries (algosdk only, no algokit-utils, no signing).
// Every number the risk bar depends on is read live: PEX risk parameters are
// admin-mutable and are never hardcoded here. See strategy/perps/SPEC.md, Invariant 8.
//
// Box layouts are PINNED rather than fetched. The protocol manifest supplies both
// the ABI specs used to encode args and the formats used to decode state, so
// whoever controls it controls what we send and what we display. Decoding against
// a pinned layout, then asserting the manifest hash separately, breaks that loop.

import algosdk from "algosdk";
import { PEX_APPS, PEX_PROGRAM_SHA256 } from "./perps";

// ── Box layouts ───────────────────────────────────────────────────────────────
// All boxes are big-endian uint64 words in declaration order.
// NB: the project targets ES2017, so bigint LITERALS (1n) are unavailable —
// use BigInt(...) throughout, as the other libs in this directory do.

const MARKET_RISK_FIELDS = [
  "min_position_size_usd", "min_collateral_usd", "initial_margin_bps", "maintenance_margin_bps",
  "max_open_interest_long", "max_open_interest_short", "max_pool_amount_long", "max_pool_amount_short",
  "max_pool_usd_for_deposit_long", "max_pool_usd_for_deposit_short",
  "reserve_factor_long_bps", "reserve_factor_short_bps",
  "max_pnl_factor_for_deposits_bps", "max_pnl_factor_for_withdrawals_bps",
  "max_pnl_factor_for_traders_bps", "max_pnl_factor_for_adl_bps", "min_pnl_factor_after_adl_bps",
  "position_impact_factor_bps", "max_position_impact_bps", "swap_impact_factor_bps", "max_swap_impact_bps",
  "open_fee_bps", "close_fee_bps", "liquidation_fee_bps", "max_liquidation_impact_bps",
  "funding_factor_milli_bps", "funding_interval_seconds",
  "base_borrowing_factor_long_milli_bps", "base_borrowing_factor_short_milli_bps",
  "full_usage_borrowing_factor_long_milli_bps", "full_usage_borrowing_factor_short_milli_bps",
  "optimal_usage_factor_long_bps", "optimal_usage_factor_short_bps",
] as const;

const MARKET_POOL_FIELDS = [
  "long_pool_amount", "short_pool_amount", "long_fee_amount", "short_fee_amount",
  "long_protocol_fee_amount", "short_protocol_fee_amount",
  "long_insurance_amount", "short_insurance_amount",
  "swap_impact_pool_long_amount", "swap_impact_pool_short_amount",
  "position_impact_pool_qty", "lent_position_impact_pool_qty",
  "bad_debt_long_amount", "bad_debt_short_amount", "unpaid_cost_usd", "market_share_supply",
] as const;

const OPEN_INTEREST_FIELDS = [
  "long_oi_usd_with_long_collateral", "long_oi_usd_with_short_collateral",
  "short_oi_usd_with_long_collateral", "short_oi_usd_with_short_collateral",
  "long_oi_tokens_with_long_collateral", "long_oi_tokens_with_short_collateral",
  "short_oi_tokens_with_long_collateral", "short_oi_tokens_with_short_collateral",
  "collateral_sum_long_token_for_longs", "collateral_sum_short_token_for_longs",
  "collateral_sum_long_token_for_shorts", "collateral_sum_short_token_for_shorts",
] as const;

const DYNAMIC_OI_FIELDS = [
  "dynamic_oi_margin_version", "dynamic_oi_margin_flags",
  "dynamic_oi_margin_long_factor_scaled", "dynamic_oi_margin_short_factor_scaled",
] as const;

// `ma2:` on Markets. Carries opposing_trader_share_bps, which the SDK's cost
// quote requires — without it quoteV2OpenPosition throws rather than returning a
// failure, so it is not optional for a quote of any kind.
const ADAPTIVE_FUNDING_FIELDS = [
  "schema_version", "mode", "saved_factor_milli_bps", "saved_factor_side",
  "increase_factor_milli_bps", "decrease_factor_milli_bps",
  "threshold_stable_bps", "threshold_decrease_bps",
  "min_factor_milli_bps", "max_factor_milli_bps", "opposing_trader_share_bps",
] as const;

// `m2:` on Markets. Carries position_conversion_scale, which sets the position
// quantization floor. It is the only non-risk box the solver needs, and it is on
// chain — so the floor does not depend on market metadata from a backend.
const MARKET_CORE_FIELDS = [
  "schema_version", "market_id", "index_asset_id", "long_asset_id",
  "short_asset_id", "market_type", "position_conversion_scale", "market_share_asset_id",
] as const;

export type MarketCore = Record<(typeof MARKET_CORE_FIELDS)[number], bigint>;
export type AdaptiveFunding = Record<(typeof ADAPTIVE_FUNDING_FIELDS)[number], bigint>;
export type MarketRisk = Record<(typeof MARKET_RISK_FIELDS)[number], bigint>;
export type MarketPool = Record<(typeof MARKET_POOL_FIELDS)[number], bigint>;
export type OpenInterest = Record<(typeof OPEN_INTEREST_FIELDS)[number], bigint>;
export type DynamicOiConfig = Record<(typeof DYNAMIC_OI_FIELDS)[number], bigint>;

// ── Scales ────────────────────────────────────────────────────────────────────
/** USD amounts on PEX are 1e6-scaled. */
export const USD_SCALE = BigInt(1_000_000);
/** `dynamicBps = sideOiAfter * factor / V2_MATH_FACTOR_SCALE`. */
export const MATH_FACTOR_SCALE = BigInt(1_000_000_000_000);

export const usd = (raw: bigint): number => Number(raw) / Number(USD_SCALE);

// ── Box plumbing ──────────────────────────────────────────────────────────────

// TextEncoder rather than Buffer: this runs in the browser, and the prefixes are
// ASCII so the two are byte-identical. Avoids depending on a Node global reaching
// the client bundle at all.
const boxKey = (prefix: string, marketId: number): Uint8Array =>
  new Uint8Array([...new TextEncoder().encode(prefix), ...algosdk.encodeUint64(BigInt(marketId))]);

function decodeWords<T extends readonly string[]>(raw: Uint8Array, fields: T): Record<T[number], bigint> {
  const words = Math.floor(raw.length / 8);
  if (words < fields.length) {
    throw new Error(`perps: box has ${words} words, layout expects ${fields.length} — pinned layout is stale`);
  }
  // Trailing words beyond the pinned layout are tolerated: PEX appends fields on
  // upgrade, and a longer box is forward-compatible. A SHORTER one is not.
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out = {} as Record<T[number], bigint>;
  fields.forEach((name, i) => {
    out[name as T[number]] = view.getBigUint64(i * 8, false);
  });
  return out;
}

async function readBox<T extends readonly string[]>(
  algod: algosdk.Algodv2, appId: number, prefix: string, marketId: number, fields: T,
): Promise<Record<T[number], bigint>> {
  const res = await algod.getApplicationBoxByName(appId, boxKey(prefix, marketId)).do();
  return decodeWords(res.value, fields);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export const readMarketCore = (algod: algosdk.Algodv2, marketId: number) =>
  readBox(algod, PEX_APPS.markets, "m2:", marketId, MARKET_CORE_FIELDS) as Promise<MarketCore>;

export const readAdaptiveFunding = (algod: algosdk.Algodv2, marketId: number) =>
  readBox(algod, PEX_APPS.markets, "ma2:", marketId, ADAPTIVE_FUNDING_FIELDS) as Promise<AdaptiveFunding>;

export const readMarketRisk = (algod: algosdk.Algodv2, marketId: number) =>
  readBox(algod, PEX_APPS.markets, "mr2:", marketId, MARKET_RISK_FIELDS) as Promise<MarketRisk>;

export const readMarketPool = (algod: algosdk.Algodv2, marketId: number) =>
  readBox(algod, PEX_APPS.markets, "mp2:", marketId, MARKET_POOL_FIELDS) as Promise<MarketPool>;

export const readOpenInterest = (algod: algosdk.Algodv2, marketId: number) =>
  readBox(algod, PEX_APPS.markets, "mo2:", marketId, OPEN_INTEREST_FIELDS) as Promise<OpenInterest>;

/**
 * Dynamic OI margin config — on TradingRiskOps, NOT Markets.
 * Without it every quote pushes `dynamic_oi_margin_missing`, and the leverage
 * ceiling cannot be solved at all.
 */
export const readDynamicOiConfig = (algod: algosdk.Algodv2, marketId: number) =>
  readBox(algod, PEX_APPS.tradingRiskOps, "doi:", marketId, DYNAMIC_OI_FIELDS) as Promise<DynamicOiConfig>;

// ── Derived ───────────────────────────────────────────────────────────────────

/**
 * Per-side open interest is the SUM of both collateral variants.
 * Reading only the USDC-collateral field overstates headroom.
 */
export function sideOiUsd(oi: OpenInterest, side: "long" | "short"): bigint {
  return side === "long"
    ? oi.long_oi_usd_with_long_collateral + oi.long_oi_usd_with_short_collateral
    : oi.short_oi_usd_with_long_collateral + oi.short_oi_usd_with_short_collateral;
}

/** Room left under `max_open_interest_*` on this side, in USD scale. Never negative. */
export function oiHeadroomUsd(risk: MarketRisk, oi: OpenInterest, side: "long" | "short"): bigint {
  const cap = side === "long" ? risk.max_open_interest_long : risk.max_open_interest_short;
  const used = sideOiUsd(oi, side);
  return cap > used ? cap - used : BigInt(0);
}

/** `k` in the ceiling solve. Per market — ALGO/USD is 1.0, BTC/USD is ~0.641. */
export function dynamicOiFactor(doi: DynamicOiConfig, side: "long" | "short"): number {
  const scaled = side === "long"
    ? doi.dynamic_oi_margin_long_factor_scaled
    : doi.dynamic_oi_margin_short_factor_scaled;
  return Number(scaled) / 1_000_000;
}

export const dynamicOiEnabled = (doi: DynamicOiConfig): boolean =>
  (doi.dynamic_oi_margin_flags & BigInt(1)) === BigInt(1);

// ── Integrity ─────────────────────────────────────────────────────────────────

export type PinCheck = { ok: boolean; drifted: string[] };

/**
 * Verify deployed approval programs still hash to what we pinned.
 *
 * This is the only control that observes a PEX upgrade: app IDs do not change on
 * one, so pinned IDs and pinned ABI specs both survive a program swap untouched.
 * With no delay window committed upstream, this is our sole automatic detection.
 *
 * On drift: block opens, keep exits live. A redeploy leaves existing positions in
 * the old app, so a blanket halt strands whoever is holding one.
 */
export async function verifyProgramPins(algod: algosdk.Algodv2): Promise<PinCheck> {
  const targets: Array<[keyof typeof PEX_PROGRAM_SHA256, number]> = [
    ["trading", PEX_APPS.trading],
    ["orderOps", PEX_APPS.orderOps],
    ["tradingRiskOps", PEX_APPS.tradingRiskOps],
    ["markets", PEX_APPS.markets],
    ["math", PEX_APPS.math],
    ["adminControl", PEX_APPS.adminControl],
  ];
  const drifted: string[] = [];
  for (const [name, appId] of targets) {
    const app = await algod.getApplicationByID(appId).do();
    const program = app.params.approvalProgram;
    if (!program) { drifted.push(`${name}: no approval program returned`); continue; }
    const bytes = Uint8Array.from(program as ArrayLike<number>);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== PEX_PROGRAM_SHA256[name]) drifted.push(`${name}: ${hex.slice(0, 16)}…`);
  }
  return { ok: drifted.length === 0, drifted };
}

// ── Composite ─────────────────────────────────────────────────────────────────

export type MarketState = {
  marketId: number;
  core: MarketCore;
  adaptive: AdaptiveFunding;
  risk: MarketRisk;
  pool: MarketPool;
  oi: OpenInterest;
  doi: DynamicOiConfig;
  readAt: number;
};

/** One round trip's worth of everything the solver needs. */
export async function readMarketState(algod: algosdk.Algodv2, marketId: number): Promise<MarketState> {
  const [core, adaptive, risk, pool, oi, doi] = await Promise.all([
    readMarketCore(algod, marketId),
    readAdaptiveFunding(algod, marketId),
    readMarketRisk(algod, marketId),
    readMarketPool(algod, marketId),
    readOpenInterest(algod, marketId),
    readDynamicOiConfig(algod, marketId),
  ]);
  if (!dynamicOiEnabled(doi)) {
    // Not fatal — it means the dynamic branch is inactive and the baseline margin
    // governs. The solver handles both; flagging it here so a silent config change
    // is visible rather than showing up as an unexplained ceiling jump.
    console.warn(`perps: dynamic OI margin disabled on market ${marketId}`);
  }
  return { marketId, core, adaptive, risk, pool, oi, doi, readAt: Date.now() };
}

// ── Builder address preflight ─────────────────────────────────────────────────

export type BuilderCheck = {
  ok: boolean;
  optedIn: boolean;
  spendableAlgo: number;
  problem?: string;
};

/**
 * Confirm the builder fee can actually be received.
 *
 * The fee is paid in the collateral asset, so if the recipient is not opted in
 * to it the transfer fails and takes the whole group with it — every open, for
 * every user, presenting as our bug rather than a treasury configuration issue.
 * Cheap to check and worth checking at startup rather than discovering on the
 * first open of the day.
 *
 * Deliberately NOT called per-quote: it is a config property, not a per-trade one.
 */
export async function assertBuilderAddressUsable(
  algod: algosdk.Algodv2, address: string, collateralAssetId: number,
): Promise<BuilderCheck> {
  if (!address) return { ok: false, optedIn: false, spendableAlgo: 0, problem: "BUILDER_ADDRESS is unset" };
  if (!algosdk.isValidAddress(address)) {
    return { ok: false, optedIn: false, spendableAlgo: 0, problem: "BUILDER_ADDRESS is not a valid address" };
  }
  const info = (await algod.accountInformation(address).do()) as unknown as {
    amount: bigint | number; minBalance: bigint | number;
    assets?: Array<{ assetId?: bigint | number; amount: bigint | number }>;
  };
  const spendableAlgo = (Number(info.amount) - Number(info.minBalance)) / Number(USD_SCALE);
  const optedIn = collateralAssetId === 0
    || (info.assets ?? []).some((a) => Number(a.assetId) === collateralAssetId);
  const problem = !optedIn
    ? `builder address is not opted in to asset ${collateralAssetId} — every open would fail`
    : spendableAlgo < 0
      ? "builder address is below its minimum balance"
      : undefined;
  return { ok: !problem, optedIn, spendableAlgo, problem };
}

// ── Order id allocation ───────────────────────────────────────────────────────

/** `v2ExpectedLinkedChildOrderId`: take-profit is base+1, stop-loss is base+2. */
export const ORDER_ID_STRIDE = BigInt(3);
/** `validateLinkBaseOrderId`: 0 < base <= (1n << 61n) - 1n - 2n. */
export const ORDER_ID_MAX_BASE = (BigInt(1) << BigInt(61)) - BigInt(3);

export type BaseOrderIdAllocation = {
  baseOrderId: bigint;
  /** Ids this bracket will occupy: base (entry link), base+1 (TP), base+2 (SL). */
  reserved: [bigint, bigint, bigint];
  /** Order ids already on chain for this owner. */
  existing: bigint[];
};

/**
 * Allocate a base order id for a new bracket, from chain.
 *
 * **Never from local state.** An id derived from a counter in localStorage, or
 * from a position count, desynchronises the moment the user opens in two tabs,
 * clears storage, or switches device — and a colliding id does not fail cleanly
 * in the UI, it fails at submission after the wallet prompt.
 *
 * Order boxes are keyed `o2: | owner | orderId`, so ids are **per owner**: two
 * users can never collide, and the only contention is a user against themselves.
 * algod supports prefix filtering, so this reads only this owner's boxes rather
 * than enumerating the whole app.
 *
 * Races are possible and are fail-safe rather than fail-dangerous: two tabs can
 * both read the same maximum and pick the same base, and the second submission is
 * rejected on chain because the box already exists. No funds move. The wallet
 * prompt is wasted, which is why this is read immediately before building.
 */
export async function allocateBaseOrderId(
  algod: algosdk.Algodv2, owner: string,
): Promise<BaseOrderIdAllocation> {
  const prefix = new Uint8Array([
    ...new TextEncoder().encode("o2:"),
    ...algosdk.decodeAddress(owner).publicKey,
  ]);
  const b64 = typeof btoa === "function"
    ? btoa(String.fromCharCode(...Array.from(prefix)))
    : Buffer.from(prefix).toString("base64");

  const existing: bigint[] = [];
  let next: string | undefined;
  // Paginate defensively: a long-lived account can accumulate order boxes.
  for (let page = 0; page < 50; page++) {
    const q = algod.getApplicationBoxes(PEX_APPS.orderOps);
    // The SDK exposes only `max`; algod itself accepts prefix/next, so they are
    // set on the query object directly.
    (q as unknown as { query: Record<string, unknown> }).query.prefix = `b64:${b64}`;
    if (next) (q as unknown as { query: Record<string, unknown> }).query.next = next;
    const res = (await q.do()) as unknown as {
      boxes?: { name: Uint8Array }[]; nextToken?: string; ["next-token"]?: string;
    };
    for (const box of res.boxes ?? []) {
      // name = "o2:"(3) | owner(32) | orderId(8)
      if (box.name.length !== 43) continue;
      existing.push(algosdk.decodeUint64(box.name.slice(35, 43), "bigint"));
    }
    next = res.nextToken ?? res["next-token"];
    if (!next) break;
  }

  const highest = existing.reduce((a, b) => (b > a ? b : a), BigInt(0));
  // base must be > 0; the whole stride sits above every id already in use.
  const baseOrderId = highest + BigInt(1);
  if (baseOrderId > ORDER_ID_MAX_BASE) {
    throw new Error("perps: order id space exhausted for this account");
  }
  return {
    baseOrderId,
    reserved: [baseOrderId, baseOrderId + BigInt(1), baseOrderId + BigInt(2)],
    existing: existing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/**
 * Confirm none of an allocation's ids are taken, immediately before signing.
 *
 * Cheap, and it closes the window between allocating and building. It cannot
 * close the window between signing and confirmation — nothing can, off chain.
 */
export async function assertBaseOrderIdFree(
  algod: algosdk.Algodv2, owner: string, alloc: BaseOrderIdAllocation,
): Promise<boolean> {
  const pk = algosdk.decodeAddress(owner).publicKey;
  for (const id of alloc.reserved) {
    const name = new Uint8Array([
      ...new TextEncoder().encode("o2:"), ...pk, ...algosdk.encodeUint64(id),
    ]);
    try {
      await algod.getApplicationBoxByName(PEX_APPS.orderOps, name).do();
      return false; // exists -> taken
    } catch {
      // 404 is the expected, healthy case.
    }
  }
  return true;
}

// ── Positions ─────────────────────────────────────────────────────────────────

/**
 * `p2:` on Trading. **14 words, and the protocol manifest is wrong about it.**
 *
 * The manifest's `position_state` entry lists 15 field names against a
 * `value_size` of 112 bytes — which is 14 words, not 15. Decoding to the manifest
 * list shifts every field after the third: `side` reads as a USD amount and
 * `collateral_amount` reads as a price. Verified against five live MainNet
 * positions; this layout reproduces sensible values for all of them.
 *
 * `position_id` is the field that is not here. It lives in the box KEY, not the
 * value — which matters, because `expectedPositionId` on a close must be a real
 * id and the wildcard closes whatever occupies the key.
 */
const POSITION_FIELDS = [
  "market_id", "collateral_asset_id", "side", "size_usd", "size_tokens",
  "collateral_amount", "pending_impact_qty_signed", "entry_price",
  "borrowing_factor_snapshot_milli_bps", "funding_fee_per_size_snapshot_milli_bps",
  "claimable_long_token_funding_per_size_snapshot",
  "claimable_short_token_funding_per_size_snapshot",
  "created_at", "updated_at",
] as const;

export type PositionState = Record<(typeof POSITION_FIELDS)[number], bigint>;

/** Read one position by its natural key. Returns null when there is none. */
export async function readPosition(
  algod: algosdk.Algodv2, owner: string, marketId: number,
  collateralAssetId: number, side: 1 | 2,
): Promise<PositionState | null> {
  const name = new Uint8Array([
    ...new TextEncoder().encode("p2:"),
    ...algosdk.decodeAddress(owner).publicKey,
    ...algosdk.encodeUint64(BigInt(marketId)),
    ...algosdk.encodeUint64(BigInt(collateralAssetId)),
    ...algosdk.encodeUint64(BigInt(side)),
  ]);
  try {
    const res = await algod.getApplicationBoxByName(PEX_APPS.trading, name).do();
    return decodeWords(res.value, POSITION_FIELDS) as PositionState;
  } catch {
    return null; // no box = no position
  }
}
