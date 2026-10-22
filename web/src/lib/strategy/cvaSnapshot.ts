/**
 * The C-Vault's state, in the shape `planV2CvaWithdraw` and the CVA builders
 * expect.
 *
 * ── Why this is its own module ──
 * Five of the six mistakes made getting the planner to run were *shape*
 * mistakes in this data, and each surfaced as a misleading error somewhere
 * else. Assembling it in one audited place is the point:
 *
 *   `oraclePayload` without the decoded price band
 *       -> "Cannot convert undefined to a BigInt", thrown from `oraclePrices`
 *   flat `resources` instead of nested `resources.app_ids`
 *       -> "v2MathAppId is required for CVA mark_market resource carrier",
 *          an error about the mark carrier caused by the resource map
 *   hand-mapped `gm2:` words instead of `parseV2CvaMarketAllocationState`
 *       -> every withdrawal refused `withdraw_cap`, because the market-route
 *          check at v2Quotes.js:578 has NO "0 means unlimited" guard (unlike
 *          the vault-level check twenty lines above it) and the missing
 *          `max_withdraw_usd_per_call` key defaulted to zero
 *   partial market record instead of `marketRecord()`
 *       -> silently reads as zeros
 *   a registry for the wrong market
 *       -> THROWS "xALGO strategy is required for action recall", rather than
 *          returning a failure
 *
 * The last one is why `registries` is keyed by market: the registry and the
 * route must be chosen together, and a mismatch is not a graceful no.
 */

import algosdk from "algosdk";
import { parseV2CvaMarketAllocationState } from "@pdex/sdk";
import { readMarketState, readYieldRegistry } from "../perpsReads";
import { marketRecord, priceInput } from "../perpsQuote";
import { getOraclePayload, type OraclePayload } from "../perpsOracle";
import { PEX_APPS, PEX_ASSETS, ORACLE_MAX_AGE_SEC } from "../perps";
import { installProtocolManifest } from "../perpsManifest";
import { readCvaVaultState, type CvaVaultState } from "./preflight";

/** `gm2:` box name for one market's allocation. */
export const cvaAllocationBoxName = (marketId: number) =>
  new Uint8Array([
    ...new TextEncoder().encode("gm2:"),
    ...algosdk.encodeUint64(BigInt(marketId)),
  ]);

/** `gu2:` box name for one depositor. */
export const cvaUserBoxName = (address: string) =>
  new Uint8Array([
    ...new TextEncoder().encode("gu2:"),
    ...algosdk.decodeAddress(address).publicKey,
  ]);

export type CvaSnapshot = {
  /** The gates' view — pauses, cooldown, spreads, floors, caps. */
  state: CvaVaultState;
  /** Vault globals as a flat record, which is what the planner's `get()` reads. */
  vault: Record<string, unknown>;
  allocations: Record<string, unknown>[];
  pools: Record<string, unknown>[];
  markets: Record<string, unknown>[];
  /** Per-market oracle payload: signed bytes AND the decoded band. */
  activeMarketOracles: Record<string, Record<string, unknown>>;
  /** The base payload, for the call itself. */
  oracle: OraclePayload;
  /** One yield registry per active market — see the module note. */
  registries: Record<number, Record<string, unknown>>;
  /** Nested, as `resourceAppIds` requires. */
  appIds: Record<string, number>;
  /** NAV per share, for sizing and display. */
  navPerShare: number;
  /** `Date.now()` when the oracle payloads were fetched, for the signing budget. */
  fetchedAt: number;
};

/**
 * Read everything in one pass.
 *
 * ⚠️ The oracle payloads inside expire in `ORACLE_MAX_AGE_SEC` (20s), so a
 * snapshot is **not** reusable across a user's deliberation. Build it when the
 * action is taken, never when the form is opened — `snapshotAgeSec` is the
 * check, and both build paths refuse a stale one rather than signing against it.
 */
export async function readCvaSnapshot(algod: algosdk.Algodv2): Promise<CvaSnapshot> {
  await installProtocolManifest();

  const state = await readCvaVaultState(algod);
  const app = await algod.getApplicationByID(PEX_APPS.cvaVault).do();
  const vault: Record<string, unknown> = { vault_id: PEX_APPS.cvaVault };
  for (const kv of app.params.globalState ?? []) {
    vault[Buffer.from(kv.key as unknown as Uint8Array).toString("utf8")] =
      BigInt(kv.value?.uint ?? 0);
  }

  const allocations: Record<string, unknown>[] = [];
  const pools: Record<string, unknown>[] = [];
  const markets: Record<string, unknown>[] = [];
  const activeMarketOracles: Record<string, Record<string, unknown>> = {};
  const registries: Record<number, Record<string, unknown>> = {};

  const fetchedAt = Date.now();
  for (const marketId of state.activeMarkets) {
    const box = await algod
      .getApplicationBoxByName(PEX_APPS.cvaVault, cvaAllocationBoxName(marketId)).do();
    allocations.push({
      vault_id: PEX_APPS.cvaVault,
      // The SDK's own parser. Hand-mapping dropped a key the contract checks
      // without an unlimited guard — see the module note.
      ...(parseV2CvaMarketAllocationState(box.value) as unknown as Record<string, unknown>),
    });

    const st = await readMarketState(algod, marketId);
    pools.push({ market_id: marketId, ...st.pool });
    // The full record: core + adaptive + risk + oi + doi.
    markets.push({ market_id: marketId, ...marketRecord(st) });

    // Targeted at the C-Vault, not at AdminOps: the vault is the app that will
    // verify these, and the signed bundle keys them `app-3690309167/market-N`.
    const o = await getOraclePayload(PEX_APPS.cvaVault, marketId);
    activeMarketOracles[String(marketId)] = {
      message: o.message, signature: o.signature, ...priceInput(o),
    };

    registries[marketId] = await readYieldRegistry(
      algod, marketId, PEX_ASSETS.usdc, Number(st.core.index_asset_id),
    ) as unknown as Record<string, unknown>;
  }

  if (state.activeMarkets.length === 0) {
    throw new Error("The vault lists no active markets, so nothing can be deposited or withdrawn.");
  }
  const oracle = await getOraclePayload(PEX_APPS.cvaVault, state.activeMarkets[0]);

  const shares = Number(vault.total_cva_shares ?? 0);
  const nav = Number(vault.total_nav_usd ?? 0);

  return {
    state, vault, allocations, pools, markets, activeMarketOracles, oracle, registries,
    appIds: {
      PDexV2AdminControl: PEX_APPS.adminControl,
      PDexV2Markets: PEX_APPS.markets,
      PDexV2Math: PEX_APPS.math,
      PDexV2CvaVault: PEX_APPS.cvaVault,
    },
    // Per SHARE, not per dollar: 0 shares is a vault nobody has entered, and
    // dividing by it would read as Infinity rather than "no price yet".
    navPerShare: shares > 0 ? nav / shares : 0,
    fetchedAt,
  };
}

export const snapshotAgeSec = (s: CvaSnapshot, now = Date.now()): number =>
  (now - s.fetchedAt) / 1000;

/** The `stateSnapshot` argument, assembled. */
export const planStateSnapshot = (s: CvaSnapshot) => ({
  cva: { vaults: [s.vault], allocations: s.allocations },
  pools: s.pools,
  markets: s.markets,
});

/**
 * The `resources` argument for one market.
 *
 * Takes the market explicitly because the registry must match the route. There
 * is deliberately no "all markets" variant: one registry goes in, and passing
 * the wrong one throws rather than failing cleanly.
 */
export const planResources = (s: CvaSnapshot, marketId: number) => {
  const registry = s.registries[marketId];
  if (!registry) {
    throw new Error(`no yield registry read for market ${marketId}`);
  }
  return { app_ids: s.appIds, market_yield_resource_registry: registry };
};

/** The `oraclePayload` argument: base bytes, decoded band, and the per-market set. */
export const planOraclePayload = (s: CvaSnapshot) => ({
  message: s.oracle.message,
  signature: s.oracle.signature,
  ...priceInput(s.oracle),
  activeMarketOracles: s.activeMarketOracles,
});

/** One depositor's vault shares, micro. Null when they have never deposited. */
export async function readCvaUserShares(
  algod: algosdk.Algodv2, address: string,
): Promise<{ shares: number; lastDepositRound: number } | null> {
  try {
    const box = await algod
      .getApplicationBoxByName(PEX_APPS.cvaVault, cvaUserBoxName(address)).do();
    const dv = new DataView(box.value.buffer, box.value.byteOffset, box.value.byteLength);
    // cva_user_state: shares @0, last_deposit_round @8 — the offset the vault's
    // own cooldown assert reads (cva.teal label58).
    return {
      shares: Number(dv.getBigUint64(0)) / 1e6,
      lastDepositRound: box.value.byteLength >= 16 ? Number(dv.getBigUint64(8)) : 0,
    };
  } catch (e) {
    if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) {
      return null;
    }
    throw e;
  }
}

/** Seconds of oracle life left, for the signing-budget check both paths make. */
export const oracleBudgetSec = (s: CvaSnapshot, now = Date.now()): number =>
  ORACLE_MAX_AGE_SEC - s.oracle.ageSeconds - (now - s.fetchedAt) / 1000;
