import { describe, it, expect } from "vitest";
import fs from "node:fs";
import algosdk from "algosdk";
import { planV2CvaWithdraw, parseV2CvaMarketAllocationState } from "@pdex/sdk";
import { readMarketState } from "@/lib/strategy/pex/reads";
import { getOraclePayload } from "@/lib/strategy/pex/oracle";
import { installProtocolManifest } from "@/lib/strategy/pex/manifest";
import { priceInput, marketRecord } from "@/lib/strategy/pex/quote";
import { readCvaVaultState } from "@/lib/strategy/pools/preflight";
import { readYieldRegistry } from "@/lib/strategy/pex/reads";
import { PEX_APPS } from "@/lib/strategy/pex/config";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
/** A real C-Vault depositor: 5.475 shares (gu2: box). */
const HOLDER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";

describe("live: can the SDK plan a C-Vault withdrawal from chain data alone?", () => {
  it("returns a route and a descriptor, including the mark legs", async () => {
    await installProtocolManifest();
    const v = await readCvaVaultState(algod);
    const vaultApp = await algod.getApplicationByID(PEX_APPS.cvaVault).do();

    // Vault globals -> a flat record, the shape the planner's `findById` wants.
    const vault: Record<string, unknown> = { vault_id: PEX_APPS.cvaVault };
    for (const kv of vaultApp.params.globalState ?? []) {
      vault[Buffer.from(kv.key as unknown as Uint8Array).toString("utf8")] =
        BigInt(kv.value?.uint ?? 0);
    }

    // gm2: allocations, and the pool/market records per active market.
    const allocations: Record<string, unknown>[] = [];
    const pools: Record<string, unknown>[] = [];
    const markets: Record<string, unknown>[] = [];
    const activeMarketOracles: Record<string, unknown> = {};
    for (const marketId of v.activeMarkets) {
      const name = new Uint8Array([
        ...new TextEncoder().encode("gm2:"), ...algosdk.encodeUint64(BigInt(marketId)),
      ]);
      const box = await algod.getApplicationBoxByName(PEX_APPS.cvaVault, name).do();
      // The SDK's OWN parser, not a hand-rolled word map. Hand-mapping omitted
      // `max_withdraw_usd_per_call`, and the market-route check at
      // v2Quotes.js:578 has no "0 means unlimited" guard — so a missing key
      // defaults to 0 and every withdrawal trips `withdraw_cap`.
      allocations.push({
        vault_id: PEX_APPS.cvaVault,
        ...parseV2CvaMarketAllocationState(box.value) as Record<string, unknown>,
      });
      const st = await readMarketState(algod, marketId);
      pools.push({ market_id: marketId, ...st.pool });
      // marketRecord() is core+adaptive+risk+oi+doi — the proven shape the
      // terminal's quotes use. An incomplete record reads as zeros.
      markets.push({ market_id: marketId, ...marketRecord(st) });
      const o = await getOraclePayload(PEX_APPS.cvaVault, marketId);
      // The planner runs `oraclePrices()` over each entry, so every payload
      // needs the DECODED band alongside the bytes — `priceInput` is the same
      // helper the terminal's quotes use.
      activeMarketOracles[String(marketId)] = {
        message: o.message, signature: o.signature, ...priceInput(o),
      };
    }

    // NAV per share, so the test asks for something above the $5 floor rather
    // than guessing: 1 share is ~$1.16 and was refused with `min_cva_withdraw`.
    const navPerShare = Number(vault.total_nav_usd) / Number(vault.total_cva_shares);
    const shareAmount = Math.ceil(6 / navPerShare * 1e6);
    console.log(`nav/share $${navPerShare.toFixed(6)}; asking ${shareAmount} µshares (~$6)`);
    console.log(`idle: ${vault.idle_long_amount} µALGO + ${vault.idle_short_amount} µUSDC`);

    const oracle = await getOraclePayload(PEX_APPS.cvaVault, v.activeMarkets[0]);
    const registry = await readYieldRegistry(
      algod, v.activeMarkets[0], 31566704, Number((markets[0] as Record<string, unknown>).index_asset_id));
    const plan = planV2CvaWithdraw({
      sender: HOLDER,
      vaultId: PEX_APPS.cvaVault,
      shareAmount: BigInt(shareAmount),
      stateSnapshot: { cva: { vaults: [vault], allocations }, pools, markets },
      // `resourceAppIds` reads `resources.app_ids` — a NESTED map. A flat one
      // silently resolves every id to 0, and the market route needs
      // PDexV2Math for its mark_market resource carrier.
      resources: {
        app_ids: {
          PDexV2AdminControl: PEX_APPS.adminControl,
          PDexV2Markets: PEX_APPS.markets,
          PDexV2Math: PEX_APPS.math,
          PDexV2CvaVault: PEX_APPS.cvaVault,
        },
        market_yield_resource_registry: registry,
      },
      // Mode 1 + the registry, exactly as the direct-pool withdrawal needs
      // (SIGNING.md §11.2). Caps are generous here only to prove the descriptor
      // builds; production derives them from the route's own outputs.
      // The registry is PER MARKET, and `resources` holds exactly one — so the
      // route and the registry must agree. Pinning the market here; production
      // plans once to learn the route, then re-plans with that market's
      // registry, the same two-pass shape the receipt forced.
      preferredMarketId: v.activeMarkets[0],
      yieldRecallMode: 1,
      maxLongReceiptAmount: BigInt(50_000_000),
      maxShortReceiptAmount: BigInt(50_000_000),
      oraclePayload: {
        message: oracle.message, signature: oracle.signature,
        ...priceInput(oracle),
        activeMarketOracles,
      },
    }) as unknown as Record<string, unknown>;

    console.log("planner ok:", plan.ok);
    expect(plan.ok, String(plan.code ?? "")).toBe(true);

    const d = plan.descriptor as Record<string, unknown>;
    // The vault's own withdraw, not the idle one: the vault holds ~$0.004 idle,
    // so every real exit comes out of a market allocation.
    expect(d.appName).toBe("PDexV2CvaVault");
    expect(d.method).toBe("withdraw_from_market");
    expect(Number(d.appId)).toBe(PEX_APPS.cvaVault);

    // THE point of this test: the SDK plans the mark preamble itself. Two
    // mark_market calls, one per funded allocation, plus their carriers —
    // which is what §9.1 feared we would have to assemble by hand.
    const marks = (d.activeMarkCalls ?? []) as Record<string, unknown>[];
    const markMarket = marks.filter((m) => m.method === "mark_market");
    expect(markMarket.length).toBe(v.activeMarkets.length);
    for (const m of markMarket) expect(Number(m.appId)).toBe(PEX_APPS.cvaVault);
    console.log(`preamble: ${marks.length} calls (${markMarket.length} mark_market), `
      + `${((d.resourceCarriers ?? []) as unknown[]).length} carriers, `
      + `fee ${d.flatFeeMicroAlgo} µALGO`);
    if (!plan.ok) {
      fs.writeFileSync("/Users/kc/.claude/jobs/36913cee/tmp/cvaplan.json",
        JSON.stringify(plan, (k, x) => typeof x === "bigint" ? x.toString() : x, 1));
      console.log("FAILURE written to tmp/cvaplan.json; code =", plan.code);
    } else {
      console.log("route:", JSON.stringify(plan.route, (k, x) => typeof x === "bigint" ? x.toString() : x).slice(0, 300));
      console.log("flow:", plan.flow, "| descriptor keys:", Object.keys(d).join(","));
      fs.writeFileSync("/Users/kc/.claude/jobs/36913cee/tmp/cvaplan.json",
        JSON.stringify(plan, (k, x) => typeof x === "bigint" ? x.toString() : x, 1));
      console.log("plan written to tmp/cvaplan.json");
    }
  }, 120_000);

  it("sweeps withdrawal sizes to find the real ceiling", async () => {
    await installProtocolManifest();
    const v = await readCvaVaultState(algod);
    const vaultApp = await algod.getApplicationByID(PEX_APPS.cvaVault).do();
    const vault: Record<string, unknown> = { vault_id: PEX_APPS.cvaVault };
    for (const kv of vaultApp.params.globalState ?? []) {
      vault[Buffer.from(kv.key as unknown as Uint8Array).toString("utf8")] =
        BigInt(kv.value?.uint ?? 0);
    }
    const allocations: Record<string, unknown>[] = [];
    const pools: Record<string, unknown>[] = [];
    const markets: Record<string, unknown>[] = [];
    const activeMarketOracles: Record<string, unknown> = {};
    for (const marketId of v.activeMarkets) {
      const name = new Uint8Array([
        ...new TextEncoder().encode("gm2:"), ...algosdk.encodeUint64(BigInt(marketId)),
      ]);
      const box = await algod.getApplicationBoxByName(PEX_APPS.cvaVault, name).do();
      allocations.push({
        vault_id: PEX_APPS.cvaVault,
        ...parseV2CvaMarketAllocationState(box.value) as Record<string, unknown>,
      });
      const st = await readMarketState(algod, marketId);
      pools.push({ market_id: marketId, ...st.pool });
      markets.push({ market_id: marketId, ...marketRecord(st) });
      const o = await getOraclePayload(PEX_APPS.cvaVault, marketId);
      activeMarketOracles[String(marketId)] = {
        message: o.message, signature: o.signature, ...priceInput(o),
      };
    }
    const oracle = await getOraclePayload(PEX_APPS.cvaVault, v.activeMarkets[0]);
    // One registry PER MARKET. A mismatch does not fail gracefully — the
    // planner THROWS "xALGO strategy is required for action recall" — so the
    // route and the registry must be chosen together.
    const registries: Record<number, unknown> = {};
    for (let i = 0; i < v.activeMarkets.length; i++) {
      registries[v.activeMarkets[i]] = await readYieldRegistry(
        algod, v.activeMarkets[i], 31566704,
        Number((markets[i] as Record<string, unknown>).index_asset_id));
    }

    const navPerShare = Number(vault.total_nav_usd) / Number(vault.total_cva_shares);
    const holderShares = 646_808_544; // ALUYA…'s gu2: balance
    console.log(`holder holds ${(holderShares / 1e6).toFixed(2)} shares `
      + `≈ $${(holderShares / 1e6 * navPerShare).toFixed(2)} at $${navPerShare.toFixed(6)}/share`);
    console.log(`vault NAV $${(Number(vault.total_nav_usd) / 1e6).toFixed(2)}`);

    const plan = (shares: number, preferred: number) => planV2CvaWithdraw({
      sender: HOLDER, vaultId: PEX_APPS.cvaVault, shareAmount: BigInt(shares),
      stateSnapshot: { cva: { vaults: [vault], allocations }, pools, markets },
      resources: {
        app_ids: {
          PDexV2AdminControl: PEX_APPS.adminControl, PDexV2Markets: PEX_APPS.markets,
          PDexV2Math: PEX_APPS.math, PDexV2CvaVault: PEX_APPS.cvaVault,
        },
        market_yield_resource_registry: registries[preferred],
      },
      preferredMarketId: preferred,
      yieldRecallMode: 1,
      maxLongReceiptAmount: BigInt(500_000_000),
      maxShortReceiptAmount: BigInt(500_000_000),
      oraclePayload: {
        message: oracle.message, signature: oracle.signature,
        ...priceInput(oracle), activeMarketOracles,
      },
    }) as unknown as Record<string, unknown>;

    for (const usd of [6, 25, 100, 250, 500, 757]) {
      const shares = Math.min(holderShares, Math.ceil(usd / navPerShare * 1e6));
      const line: string[] = [];
      for (const mkt of v.activeMarkets) {
        let r: Record<string, unknown>;
        try { r = plan(shares, mkt); }
        catch (e) { line.push(`m${mkt}:THREW`); continue; }
        const q = ((r.details as Record<string, unknown>)?.quote
          ?? (r.route as Record<string, unknown>)?.quote) as Record<string, unknown> | undefined;
        line.push(r.ok
          ? `m${mkt}:OK(${q?.route_type ?? "?"})`
          : `m${mkt}:${r.code}${q?.failure_reasons ? JSON.stringify(q.failure_reasons) : ""}`);
      }
      console.log(`$${String(usd).padStart(4)} (${String(shares).padStart(10)} µsh)  ${line.join("  ")}`);
    }
  }, 180_000);
});
