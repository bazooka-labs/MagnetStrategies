// MagnetFi v2 — read-only on-chain queries (algosdk only, no algokit-utils, no signing).
// Kept separate from magnetfiClient so the default (Overview) view stays lightweight.

import algosdk from "algosdk";
import { ACTIVE, PSM_REDEEM_FEE_BPS } from "./magnetfi";

const ORACLE_FRESHNESS = 1_800; // 30 min

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

const poolKey = (prefix: string) =>
  new Uint8Array([...Buffer.from(prefix), ...algosdk.encodeUint64(BigInt(ACTIVE.poolId))]);

export type OracleInfo = { price: number; ts: number; fresh: boolean };

export async function getOracle(algod: algosdk.Algodv2): Promise<OracleInfo> {
  const app = await algod.getApplicationByID(ACTIVE.oracle).do();
  const price = globalUint(app, poolKey("lp_price_")) ?? 0;
  const ts = globalUint(app, poolKey("lp_ts_")) ?? 0;
  const now = Math.floor(Date.now() / 1000);
  return { price: price / 1_000_000, ts, fresh: ts > 0 && now - ts <= ORACLE_FRESHNESS };
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
  rateBps: number; lastPaymentTs: number; vaultState: number;
};

export async function getVaultPosition(algod: algosdk.Algodv2, borrower: string): Promise<VaultPosition | null> {
  const name = new Uint8Array([
    ...Buffer.from("vault_"),
    ...algosdk.decodeAddress(borrower).publicKey,
    ...algosdk.encodeUint64(BigInt(ACTIVE.poolId)),
  ]);
  try {
    const box = await algod.getApplicationBoxByName(ACTIVE.vault, name).do();
    const v = new DataView(box.value.buffer, box.value.byteOffset, box.value.byteLength);
    const u = (i: number) => Number(v.getBigUint64(i * 8));
    return {
      lpAmount: fromBase(u(0)), musdBorrowed: fromBase(u(2)), accruedInterest: fromBase(u(3)),
      rateBps: u(4), lastPaymentTs: u(6), vaultState: u(7),
    };
  } catch {
    return null;
  }
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

export async function getBalances(algod: algosdk.Algodv2, address: string): Promise<Balances> {
  const info = await algod.accountInformation(address).do();
  const held = new Map((info.assets ?? []).map((x) => [Number(x.assetId), Number(x.amount)]));
  return {
    algo: Number(info.amount) / 1_000_000,
    musd: fromBase(held.get(ACTIVE.musd) ?? 0),
    usdc: fromBase(held.get(ACTIVE.usdc) ?? 0),
    lp: fromBase(held.get(ACTIVE.lpAsaId) ?? 0),
    optedMusd: held.has(ACTIVE.musd),
    optedUsdc: held.has(ACTIVE.usdc),
    optedLp: held.has(ACTIVE.lpAsaId),
  };
}
