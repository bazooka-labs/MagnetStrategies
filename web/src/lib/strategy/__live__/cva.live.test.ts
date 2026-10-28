/**
 * The C-Vault paths, built and simulated against MainNet.
 *
 * Nothing is signed: `simulateGroup` runs with empty signatures. The planner
 * returning ok is NOT the chain accepting a group — this session has twice
 * found the gap — so these go all the way to a simulation and a decoded receipt.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { readCvaSnapshot, readCvaUserShares, oracleBudgetSec } from "@/lib/strategy/pools/cvaSnapshot";
import {
  buildCvaWithdraw, buildCvaDeposit, chooseWithdrawRoute, markMarketsFor,
  cvaStoragePaymentFor, CVA_USER_BOX_MBR_MICRO_ALGO, assertCvaWithdrawGroup,
} from "@/lib/strategy/pools/cvaGroup";
import { readBalances } from "@/lib/strategy/pools/preflight";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
/** A real C-Vault depositor: 646.8 shares (gu2: box). */
const HOLDER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";

describe("live: C-Vault snapshot", () => {
  it("reads a complete, fresh snapshot", async () => {
    const s = await readCvaSnapshot(algod);
    expect(s.state.activeMarkets).toEqual([1, 2]);
    expect(s.allocations.length).toBe(2);
    expect(s.pools.length).toBe(2);
    expect(s.markets.length).toBe(2);
    expect(Object.keys(s.activeMarketOracles).sort()).toEqual(["1", "2"]);
    expect(Object.keys(s.registries).map(Number).sort()).toEqual([1, 2]);
    expect(s.navPerShare).toBeGreaterThan(0);
    // The allocation key whose absence silently refused every withdrawal.
    for (const a of s.allocations) {
      expect(a.max_withdraw_usd_per_call, JSON.stringify(Object.keys(a))).toBeDefined();
    }
    console.log(`nav/share $${s.navPerShare.toFixed(6)}, marks needed: `
      + `[${markMarketsFor(s).join(",")}], oracle budget ${oracleBudgetSec(s).toFixed(1)}s`);
  }, 120_000);
});

describe("live: C-Vault withdrawal", () => {
  it("builds, asserts and simulates a real exit", async () => {
    const snap = await readCvaSnapshot(algod);
    const held = await readCvaUserShares(algod, HOLDER);
    expect(held).not.toBeNull();
    console.log(`holder: ${held!.shares.toFixed(6)} shares `
      + `≈ $${(held!.shares * snap.navPerShare).toFixed(2)}`);

    // ~$10, comfortably over the $5 floor.
    const shareAmount = BigInt(Math.ceil(10 / snap.navPerShare * 1e6));
    const r = await buildCvaWithdraw({
      algod, sender: HOLDER, snapshot: snap, shareAmount,
      maxLongReceipt: BigInt(500_000_000), maxShortReceipt: BigInt(500_000_000),
      slippageBps: 100,
    });
    expect(r.assertion.ok).toBe(true);
    expect(r.route?.routeType).toBe("single_market");
    const f = r.receipt.fields;
    console.log(`withdraw ${shareAmount} µsh via market ${r.route?.marketId}: `
      + `${r.txns.length} txns, ${r.txns.reduce((a, t) => a + Number(t.fee), 0)} µALGO, `
      + `out ${f.long_out ?? f.long_amount_out} µALGO + ${f.short_out ?? f.short_amount_out} µUSDC`);
    console.log("checks:", r.assertion.checked);
  }, 120_000);

  it("catches a tampered share amount on the real group", async () => {
    const snap = await readCvaSnapshot(algod);
    const shareAmount = BigInt(Math.ceil(10 / snap.navPerShare * 1e6));
    const caps = { long: BigInt(500_000_000), short: BigInt(500_000_000) };
    const { route } = chooseWithdrawRoute(snap, HOLDER, shareAmount, caps);
    const r = await buildCvaWithdraw({
      algod, sender: HOLDER, snapshot: snap, shareAmount,
      maxLongReceipt: caps.long, maxShortReceipt: caps.short, slippageBps: 100,
    });
    const recall = (snap.registries[route.marketId].recall ?? {}) as
      { accounts: string[]; assets: number[]; apps: number[] };
    const bad = assertCvaWithdrawGroup(r.txns, {
      sender: HOLDER,
      shareAmount: shareAmount * BigInt(3),
      minAlgoMicro: BigInt(0), minUsdcMicro: BigInt(0),
      route, maxLongReceipt: caps.long, maxShortReceipt: caps.short,
      markMarkets: markMarketsFor(snap), recall,
    }, snap);
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((f) => f.code)).toContain("share_amount");
  }, 120_000);

  it("refuses an amount under the vault's withdrawal floor", async () => {
    const snap = await readCvaSnapshot(algod);
    // ~$1, well under the $5 min_cva_withdraw_usd.
    const tiny = BigInt(Math.ceil(1 / snap.navPerShare * 1e6));
    await expect(buildCvaWithdraw({
      algod, sender: HOLDER, snapshot: snap, shareAmount: tiny,
      maxLongReceipt: BigInt(500_000_000), maxShortReceipt: BigInt(500_000_000),
      slippageBps: 100,
    })).rejects.toThrow();
  }, 120_000);
});

describe("live: C-Vault deposit", () => {
  it("charges the gu2: box MBR to a first-time depositor only", async () => {
    expect(cvaStoragePaymentFor(false)).toBe(CVA_USER_BOX_MBR_MICRO_ALGO);
    expect(cvaStoragePaymentFor(true)).toBe(BigInt(0));
    expect(CVA_USER_BOX_MBR_MICRO_ALGO).toBe(BigInt(32_900));
  });

  it("builds, asserts and simulates a deposit from an existing holder", async () => {
    const snap = await readCvaSnapshot(algod);
    const held = await readCvaUserShares(algod, HOLDER);
    const bal = await readBalances(algod, HOLDER);
    console.log(`holder wallet: ${(bal.algoSpendableMicro / 1e6).toFixed(3)} ALGO, `
      + `${(bal.usdcMicro / 1e6).toFixed(2)} USDC`);

    const r = await buildCvaDeposit({
      algod, sender: HOLDER, snapshot: snap,
      algoMicro: BigInt(0), usdcMicro: BigInt(6_000_000),
      storagePaymentMicro: cvaStoragePaymentFor(held !== null),
      slippageBps: 100,
    });
    expect(r.assertion.ok).toBe(true);
    const f = r.receipt.fields;
    console.log(`deposit $6 USDC: ${r.txns.length} txns, `
      + `${r.txns.reduce((a, t) => a + Number(t.fee), 0)} µALGO, `
      + `minted ${f.cva_shares_minted ?? f.shares_minted} shares`);
    console.log("checks:", r.assertion.checked);
  }, 120_000);
});
