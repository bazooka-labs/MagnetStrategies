// MagnetFi v2 — read-only on-chain queries (algosdk only, no algokit-utils, no signing).
// Kept separate from magnetfiClient so the default (Overview) view stays lightweight.

import algosdk from "algosdk";
import { ACTIVE, ACTIVE_ORACLE_POOLS, PSM_REDEEM_FEE_BPS } from "./magnetfi";

export const ORACLE_FRESHNESS = 1_800; // 30 min — MUST match vault/contract.py ORACLE_FRESHNESS

/**
 * Is a posted price still inside the vault's window, AS OF `nowSec`?
 *
 * Takes the clock as an argument on purpose. `OracleInfo` used to carry a
 * boolean `fresh` computed at fetch time, which froze: a liquidation console
 * left open for hours kept reporting "fresh", a confident health factor and
 * enabled liquidation buttons, all derived from an hours-old price. The chain
 * rejected the resulting transaction — ORACLE_FRESHNESS is enforced in
 * open_vault, borrow_more and all three trigger_*_liquidation — so it misled
 * the operator rather than losing money. Misleading them at the moment they
 * decide to liquidate is still the worst place to do it.
 *
 * Both call sites already tick a `nowSec` every 60s for the interest
 * projection, so passing it costs nothing and the answer now decays on screen.
 */
export const priceIsFresh = (ts: number, nowSec: number): boolean =>
  ts > 0 && nowSec - ts <= ORACLE_FRESHNESS;
/** Half the window: two missed 5-minute cycles, with time left to act. */
const ORACLE_WARN_AGE = 900;

export const MUSD_ID = ACTIVE.musd;
export const USDC_ID = ACTIVE.usdc;
export const LP_ID = ACTIVE.lpAsaId;
export const POOL_ID = ACTIVE.poolId;
export const REDEEM_FEE_BPS = PSM_REDEEM_FEE_BPS;

const fromBase = (base: number | bigint) => Number(base) / 1_000_000;
const appAddr = (id: number) => algosdk.getApplicationAddress(id).toString();

function globalUint(app: algosdk.modelsv2.Application, keyBytes: Uint8Array): number | undefined {
  const target = Buffer.from(keyBytes).toString("base64");
  const gs = app.params.globalState ?? [];
  for (const kv of gs) {
    const k = typeof kv.key === "string" ? kv.key : Buffer.from(kv.key).toString("base64");
    if (k === target && kv.value.type === 2) return Number(kv.value.uint);
  }
  return undefined;
}

// Pool-specific reads/writes take a poolId; it defaults to the primary (U/tALGO) pool so existing
// single-pool callers are unchanged, while multi-pool callers (VaultsTab) pass each pool explicitly.
const poolKey = (prefix: string, poolId: number = ACTIVE.poolId) =>
  new Uint8Array([...Buffer.from(prefix), ...algosdk.encodeUint64(BigInt(poolId))]);

/** No `fresh` field by design — it would be a snapshot. Use `priceIsFresh(ts, nowSec)`. */
export type OracleInfo = { price: number; ts: number };

/**
 * The oracle the VAULT is reading, asked of the vault rather than assumed.
 *
 * `ACTIVE.oracle` is a guess that is correct only until the next repoint, and
 * on 2026-10-17 it was briefly wrong in production by design: the constant had
 * to be edited and shipped BEFORE `confirm_lp_oracle` or the UI would have
 * reported the retired oracle's price and freshness across the cutover. That
 * ordering worked, but only because someone remembered it. This removes the
 * requirement to remember.
 *
 * Falls back to the constant when the vault read fails. A price display must
 * not go blank because one extra call did — and the constant is right whenever
 * no migration is in flight, which is almost always.
 *
 * But the fallback is WARNED, not silent. The window where it is wrong is
 * exactly the window where it matters: between a repoint and the constant
 * being shipped, a flaky vault read sends every price on the page to the
 * oracle the vault just stopped using. The write path is unaffected — the
 * transaction builders resolve the vault's real oracle through simulate — so
 * this misleads a reader rather than mispricing a trade. That is still worth
 * a line in the console rather than nothing at all.
 */
export async function getActiveOracleId(algod: algosdk.Algodv2): Promise<number> {
  try {
    const app = await algod.getApplicationByID(ACTIVE.vault).do();
    return globalUint(app, new Uint8Array(Buffer.from("lp_oracle_app_id"))) || ACTIVE.oracle;
  } catch (e) {
    console.warn(
      `[magnetfi] could not read lp_oracle_app_id from vault ${ACTIVE.vault}; ` +
      `falling back to the compiled-in oracle ${ACTIVE.oracle}. If a repoint has ` +
      `happened and this constant is behind, prices on this page are from the ` +
      `WRONG oracle.`, e);
    return ACTIVE.oracle;
  }
}

/**
 * `oracleId` is optional and resolves from the VAULT when omitted. Callers that
 * read several pools at once should resolve it once and pass it, rather than
 * paying a vault read per pool.
 */
export async function getOracle(
  algod: algosdk.Algodv2, poolId: number = ACTIVE.poolId, oracleId?: number,
): Promise<OracleInfo> {
  const app = await algod.getApplicationByID(oracleId || await getActiveOracleId(algod)).do();
  const price = globalUint(app, poolKey("lp_price_", poolId)) ?? 0;
  const ts = globalUint(app, poolKey("lp_ts_", poolId)) ?? 0;
  const now = Math.floor(Date.now() / 1000);
  return { price: price / 1_000_000, ts };
}

/**
 * Everything the admin needs to see a freeze coming, per pool.
 *
 * ── Why the band matters as much as the age ───────────────────────────────
 * Staleness is the symptom; the band is the cause. On 2026-10-07 the U/tALGO
 * feed stopped because its price reached the bot's ceiling — the last posted
 * value was 0.13% under it — and the first anyone knew was six and a half hours
 * of a frozen lending market. The distance to the band edge is a LEADING
 * indicator: it shrinks for hours before anything breaks, and nothing in the
 * product showed it.
 *
 * The anchor band is GONE from this type as of 2026-10-17. It described the
 * banded oracle's ±25% guard, which was retired with that oracle
 * (ORACLE_LEAN_SPEC.md §6 step 8); the lean oracle stores no `lp_anchor_` keys
 * and implements no `set_price_anchor`, so every band field was permanently
 * null and the "re-anchor to escape it" advice pointed at a control that no
 * longer exists.
 *
 * That removal changes what this panel is FOR. The band used to reject a wrong
 * price on chain, so staleness was the main hazard and a freeze was the band
 * doing its job. The lean oracle rejects nothing: a wrong price posts and the
 * vault prices collateral off it. The bot's own bounds in config.json are now
 * the only pre-post check, and they cannot be read from chain — which is why
 * the independent cross-check strip below is no longer a nice-to-have.
 */
export type PoolOracleHealth = {
  id: string;
  poolId: number;
  price: number;
  ts: number;
  ageSec: number;
  /** False for a pool the oracle prices but the vault cannot lend against yet. */
  vaultWired: boolean;
  level: "ok" | "warn" | "critical";
};

/**
 * Which oracle the VAULT is actually reading, and whether a swap is queued.
 *
 * Read from the vault rather than from the `ACTIVE.oracle` constant, because
 * during an oracle migration the constant is a guess and the vault is the fact.
 * `confirm_lp_oracle` moves the vault the instant it lands; a UI keyed off a
 * compiled-in id keeps reporting the old oracle's freshness until someone
 * redeploys the frontend, which is an ordering mistake waiting to happen
 * (ORACLE_LEAN_SPEC.md §6 names it as the structural fix for that whole class).
 */
export type OracleSwapState = {
  activeOracle: number;
  /** The queued oracle during the 48h window; null when nothing is pending. */
  pendingOracle: number | null;
  /** Unix seconds when the pending swap may be confirmed. */
  pendingEtaSec: number | null;
  /** True when the vault is reading something other than the compiled-in constant. */
  driftedFromConstant: boolean;
};

export async function getOracleSwapState(algod: algosdk.Algodv2): Promise<OracleSwapState> {
  const app = await algod.getApplicationByID(ACTIVE.vault).do();
  const u = (k: string): number => globalUint(app, new Uint8Array(Buffer.from(k))) ?? 0;
  const activeOracle = u("lp_oracle_app_id") || ACTIVE.oracle;
  const pending = u("pending_lp_oracle");
  const eta = u("pending_lp_oracle_eta");
  return {
    activeOracle,
    pendingOracle: pending || null,
    pendingEtaSec: pending ? eta || null : null,
    driftedFromConstant: activeOracle !== ACTIVE.oracle,
  };
}

/**
 * `oracleId` omitted means "whichever oracle the vault is reading", resolved
 * from the vault.
 *
 * Two callers, and they differ on purpose. OracleHealthPanel passes an id
 * explicitly because it also monitors the PENDING oracle during a migration
 * window — that one is by definition not the vault's yet, and it must be fresh
 * before the confirm lands or the cutover arrives into a frozen protocol.
 * OperationsPanel's "register all pools" step omits it, so the `add_pool` seed
 * prices for a NEW oracle come from whichever oracle the vault is actually
 * reading rather than from a constant that may be mid-migration. That seeding
 * path is the reason the fallback below must not be silent.
 */
export async function getOracleHealth(
  algod: algosdk.Algodv2, oracleId?: number,
): Promise<PoolOracleHealth[]> {
  const app = await algod.getApplicationByID(oracleId || await getActiveOracleId(algod)).do();
  const now = Math.floor(Date.now() / 1000);
  // Every pool the ORACLE carries, not just the vault-wired ones — a feed that
  // is not posting has to be visible whether or not anyone can borrow on it.
  return ACTIVE_ORACLE_POOLS.map((w) => {
    const id = w.id;
    const price = (globalUint(app, poolKey("lp_price_", w.poolId)) ?? 0) / 1_000_000;
    const ts = globalUint(app, poolKey("lp_ts_", w.poolId)) ?? 0;
    const ageSec = ts > 0 ? now - ts : 0;
    // A pool that has never posted is not stale — add_pool has not run.
    const level: PoolOracleHealth["level"] =
      ts === 0 ? "ok"
        : ageSec >= ORACLE_FRESHNESS ? "critical"
        : ageSec >= ORACLE_WARN_AGE ? "warn"
        : "ok";
    return { id, poolId: w.poolId, vaultWired: w.vaultWired, price, ts, ageSec, level };
  });
}

/**
 * Admin / guardian / bot addresses on an oracle app.
 *
 * Used to prefill the migration forms. A guardian pasted by hand is a 58-char
 * opportunity to get it wrong, and the guardian is fixed at deploy (rotatable
 * only through propose/accept), so reading the live one is both safer and the
 * correct default — the new oracle should answer to the same people.
 */
export type OracleRoles = { admin: string; guardian: string; authorizedUpdater: string };

export async function getOracleRoles(
  algod: algosdk.Algodv2, oracleId?: number,
): Promise<OracleRoles> {
  const app = await algod.getApplicationByID(oracleId || await getActiveOracleId(algod)).do();
  const read = (k: string): string => {
    const target = Buffer.from(k).toString("base64");
    for (const kv of app.params.globalState ?? []) {
      const key = typeof kv.key === "string" ? kv.key : Buffer.from(kv.key).toString("base64");
      if (key !== target) continue;
      const raw = kv.value.bytes;
      const bytes = typeof raw === "string" ? Buffer.from(raw, "base64") : Buffer.from(raw ?? []);
      if (bytes.length !== 32) return "";
      return algosdk.encodeAddress(new Uint8Array(bytes));
    }
    return "";
  };
  return { admin: read("admin"), guardian: read("guardian"), authorizedUpdater: read("authorized_updater") };
}

export type ProtocolStats = { circulating: number; ceiling: number; psmUsdc: number; oracle: OracleInfo };

export async function getProtocolStats(algod: algosdk.Algodv2): Promise<ProtocolStats> {
  const asset = await algod.getAssetByID(ACTIVE.musd).do();
  const total = Number(asset.params.total);
  const psm = await algod.accountInformation(appAddr(ACTIVE.psm)).do();
  const held = new Map((psm.assets ?? []).map((x) => [Number(x.assetId), Number(x.amount)]));
  const psmMusd = held.get(ACTIVE.musd) ?? 0;
  const psmUsdc = held.get(ACTIVE.usdc) ?? 0;
  const circulating = total - psmMusd;
  return {
    circulating: fromBase(circulating),
    ceiling: fromBase(Math.max(0, psmUsdc - circulating)),
    psmUsdc: fromBase(psmUsdc),
    oracle: await getOracle(algod),
  };
}

export type VaultPosition = {
  lpAmount: number; musdBorrowed: number; accruedInterest: number;
  rateBps: number; lastAccrualTs: number; lastPaymentTs: number; vaultState: number;
};

export async function getVaultPosition(algod: algosdk.Algodv2, borrower: string, poolId: number = ACTIVE.poolId): Promise<VaultPosition | null> {
  const name = new Uint8Array([
    ...Buffer.from("vault_"),
    ...algosdk.decodeAddress(borrower).publicKey,
    ...algosdk.encodeUint64(BigInt(poolId)),
  ]);
  try {
    const box = await algod.getApplicationBoxByName(ACTIVE.vault, name).do();
    const v = new DataView(box.value.buffer, box.value.byteOffset, box.value.byteLength);
    const u = (i: number) => Number(v.getBigUint64(i * 8));
    return {
      lpAmount: fromBase(u(0)), musdBorrowed: fromBase(u(2)), accruedInterest: fromBase(u(3)),
      rateBps: u(4), lastAccrualTs: u(5), lastPaymentTs: u(6), vaultState: u(7),
    };
  } catch {
    return null;
  }
}

/**
 * Total mUSD principal borrowed across ALL open vault boxes — the true amount lent
 * against LP collateral. Distinct from `circulating` mUSD (which also counts minted
 * mUSD and collected fees), so this is the correct basis for vault utilization.
 */
export async function getTotalVaultDebt(algod: algosdk.Algodv2): Promise<number> {
  const prefix = Buffer.from("vault_");
  const res = await algod.getApplicationBoxes(ACTIVE.vault).do();
  let total = BigInt(0);
  for (const b of res.boxes) {
    const name = b.name;
    if (name.length < prefix.length || !Buffer.from(name.slice(0, prefix.length)).equals(prefix)) continue;
    const box = await algod.getApplicationBoxByName(ACTIVE.vault, name).do();
    const dv = new DataView(box.value.buffer, box.value.byteOffset, box.value.byteLength);
    total += dv.getBigUint64(16); // musd_borrowed = uint64 slot 2 (bytes 16..24)
  }
  return fromBase(total);
}

export type AdminPosition = {
  borrower: string;        // 58-char address
  poolId: number;
  lpAmount: number;        // display LP
  musdBorrowed: number;    // display mUSD
  accruedInterest: number; // stored (lazy) accrued interest, display
  rateBps: number;
  lastAccrualTs: number;
  lastPaymentTs: number;
  vaultState: number;      // 0 healthy · 1 overdue-marked · 2 in settlement
};

/**
 * Every open vault position across all pools — one row per `vault_{borrower}{poolId}` box.
 * Admin-facing: the borrower address comes from the box name; the rest from the box value.
 * Layout mirrors getVaultPosition; `vault_` is the vault's only box prefix (per-pool params
 * live in global state), so no non-position box is misparsed. Derived metrics (USD value,
 * health factor, live interest, past-due) are computed in the UI with the per-pool oracle
 * price + config, keeping this a pure chain read.
 */
export async function getAllPositions(algod: algosdk.Algodv2): Promise<AdminPosition[]> {
  const prefix = Buffer.from("vault_");
  const res = await algod.getApplicationBoxes(ACTIVE.vault).do();
  const out: AdminPosition[] = [];
  for (const b of res.boxes) {
    const name = b.name;
    if (name.length < prefix.length + 40) continue; // "vault_"(6) + pubkey(32) + poolId(8)
    if (!Buffer.from(name.slice(0, prefix.length)).equals(prefix)) continue;
    const borrower = algosdk.encodeAddress(name.slice(6, 38));
    const box = await algod.getApplicationBoxByName(ACTIVE.vault, name).do();
    const v = new DataView(box.value.buffer, box.value.byteOffset, box.value.byteLength);
    const u = (i: number) => Number(v.getBigUint64(i * 8));
    out.push({
      borrower,
      poolId: u(1),
      lpAmount: fromBase(u(0)),
      musdBorrowed: fromBase(u(2)),
      accruedInterest: fromBase(u(3)),
      rateBps: u(4),
      lastAccrualTs: u(5),
      lastPaymentTs: u(6),
      vaultState: u(7),
    });
  }
  return out;
}

// ── PSM v3 — Productive Reserves reads ────────────────────────────────────────────

const ONE_14_DP = BigInt(100000000000000);
const FOLKS_INDEX_OFFSET = 40; // byte offset of depositInterestIndex in pool global key "i"

function globalBytesVal(app: algosdk.modelsv2.Application, keyBytes: Uint8Array): Uint8Array | undefined {
  const target = Buffer.from(keyBytes).toString("base64");
  for (const kv of app.params.globalState ?? []) {
    const k = typeof kv.key === "string" ? kv.key : Buffer.from(kv.key).toString("base64");
    if (k === target && kv.value.type === 1) {
      return typeof kv.value.bytes === "string" ? new Uint8Array(Buffer.from(kv.value.bytes, "base64")) : kv.value.bytes;
    }
  }
  return undefined;
}

function unpack5(raw: Uint8Array | undefined): bigint[] {
  if (!raw || raw.length < 40) return [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)];
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return [0, 1, 2, 3, 4].map((i) => v.getBigUint64(i * 8));
}

async function folksDepositIndex(algod: algosdk.Algodv2, poolAppId: number): Promise<bigint> {
  const pool = await algod.getApplicationByID(poolAppId).do();
  const raw = globalBytesVal(pool, new Uint8Array([0x69])); // key "i"
  if (!raw || raw.length < FOLKS_INDEX_OFFSET + 8) return BigInt(0);
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(FOLKS_INDEX_OFFSET);
}

export type AdapterPosition = {
  appId: number; principal: number; recoverable: number; yield: number; impaired: boolean;
};

export type StrategyStats = {
  onChainUsdc: number; deployedBacking: number; totalBacking: number;
  circulating: number; backingRatio: number; deficit: number;
  bufferBps: number; venueCapBps: number; adapters: AdapterPosition[];
};

/** True if the PSM has ≥1 whitelisted adapter — borrows then live-read it, so their group needs
 *  reference-slot padding. Returns false for a v2 PSM (no adapter_ids key) or on any read error. */
export async function hasActiveAdapter(algod: algosdk.Algodv2, psmId: number = ACTIVE.psm): Promise<boolean> {
  try {
    const app = await algod.getApplicationByID(psmId).do();
    return unpack5(globalBytesVal(app, Buffer.from("adapter_ids"))).some((x) => x !== BigInt(0));
  } catch {
    return false;
  }
}

/** Full productive-reserves view: backing ratio, deficit, and each adapter's live position. */
export async function getStrategyStats(algod: algosdk.Algodv2, psmId: number = ACTIVE.psm): Promise<StrategyStats> {
  const psmApp = await algod.getApplicationByID(psmId).do();
  const deficit = globalUint(psmApp, Buffer.from("reserve_deficit")) ?? 0;
  const bufferBps = globalUint(psmApp, Buffer.from("buffer_bps")) ?? 0;
  const venueCapBps = globalUint(psmApp, Buffer.from("max_venue_bps")) ?? 0;
  const ids = unpack5(globalBytesVal(psmApp, Buffer.from("adapter_ids")));
  const principals = unpack5(globalBytesVal(psmApp, Buffer.from("deployed_principal")));
  const impaired = unpack5(globalBytesVal(psmApp, Buffer.from("adapter_impaired")));

  const asset = await algod.getAssetByID(ACTIVE.musd).do();
  const total = BigInt(asset.params.total);
  const psmAcct = await algod.accountInformation(appAddr(psmId)).do();
  const psmHeld = new Map((psmAcct.assets ?? []).map((x) => [Number(x.assetId), BigInt(x.amount)]));
  const onChainUsdc = psmHeld.get(ACTIVE.usdc) ?? BigInt(0);
  const circulating = total - (psmHeld.get(ACTIVE.musd) ?? BigInt(0));

  const adapters: AdapterPosition[] = [];
  let deployedBacking = BigInt(0);
  for (let i = 0; i < 5; i++) {
    const appId = Number(ids[i]);
    if (appId === 0) continue;
    const principal = principals[i];
    const isImp = impaired[i] === BigInt(1);
    let recoverable = BigInt(0);
    try {
      const adApp = await algod.getApplicationByID(appId).do();
      const fusdcId = globalUint(adApp, Buffer.from("fusdc_asa_id")) ?? 0;
      const poolId = globalUint(adApp, Buffer.from("pool_app_id")) ?? 0;
      const adAcct = await algod.accountInformation(appAddr(appId)).do();
      const fusdcBal = BigInt((adAcct.assets ?? []).find((x) => Number(x.assetId) === fusdcId)?.amount ?? 0);
      const idx = poolId ? await folksDepositIndex(algod, poolId) : BigInt(0);
      recoverable = (fusdcBal * idx) / ONE_14_DP;
    } catch {
      /* adapter/pool unreadable — leave recoverable 0 */
    }
    const y = recoverable > principal ? recoverable - principal : BigInt(0);
    adapters.push({
      appId, principal: fromBase(principal), recoverable: fromBase(recoverable),
      yield: fromBase(y), impaired: isImp,
    });
    if (!isImp) deployedBacking += principal < recoverable ? principal : recoverable;
  }

  const totalBacking = onChainUsdc + deployedBacking;
  const backingRatio = circulating > BigInt(0) ? Number(totalBacking) / Number(circulating) : 1;
  return {
    onChainUsdc: fromBase(onChainUsdc), deployedBacking: fromBase(deployedBacking),
    totalBacking: fromBase(totalBacking), circulating: fromBase(circulating),
    backingRatio, deficit: fromBase(deficit), bufferBps, venueCapBps, adapters,
  };
}

export type Balances = {
  algo: number; musd: number; usdc: number; lp: number;
  optedMusd: boolean; optedUsdc: boolean; optedLp: boolean;
};

export async function getBalances(algod: algosdk.Algodv2, address: string, lpAsaId: number = ACTIVE.lpAsaId): Promise<Balances> {
  const info = await algod.accountInformation(address).do();
  const held = new Map((info.assets ?? []).map((x) => [Number(x.assetId), Number(x.amount)]));
  return {
    algo: Number(info.amount) / 1_000_000,
    musd: fromBase(held.get(ACTIVE.musd) ?? 0),
    usdc: fromBase(held.get(ACTIVE.usdc) ?? 0),
    lp: fromBase(held.get(lpAsaId) ?? 0),
    optedMusd: held.has(ACTIVE.musd),
    optedUsdc: held.has(ACTIVE.usdc),
    optedLp: held.has(lpAsaId),
  };
}
