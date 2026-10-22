/**
 * LIVE MainNet validation of the liquidity groups. Not part of `npm test`.
 *
 * Run with:  npx vitest run --config vitest.live.config.ts
 *
 * A hermetic test can only prove the assertion agrees with the SDK. It cannot
 * prove the group is one MainNet accepts — the box references, the resource
 * carriers, the yield recall, the oracle binding and the cool-down all live on
 * chain, and three of those were wrong in the first draft and found here.
 *
 * Nothing is signed and nothing is sent: `simulateGroup` runs with empty
 * signatures.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { buildWithdraw, buildDeposit, assertWithdrawGroup } from "../group";
import {
  readQuoteContext, quoteDeposit, quoteWithdraw, readRecallContext, recallCaps,
  DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
} from "../quote";
import {
  readMarketGateState, readBalances, marketGates, directCooldownGate,
  readCvaVaultState,
} from "../preflight";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");

/**
 * A real market-1 LP, recovered from the `ml2:` box list: 0.92902 shares,
 * deposited 2026-09-09, so its cool-down is long past. 568 ALGO, 0.827 USDC.
 */
const LP = "A4YW55ZEC2TTIN2TEVN56IRVGLWQYQRUNJTPG37OTWE4EJWNAH3EUKHZKA";

async function withdrawInputs(shareAmount: bigint) {
  const ctx = await readQuoteContext(algod, 1);
  const q = quoteWithdraw(ctx, shareAmount);
  expect(q.ok).toBe(true);
  const caps = recallCaps(q);
  const rc = await readRecallContext(algod, ctx);
  return {
    q,
    registry: rc.registry,
    recall: rc.recall,
    maxLongReceipt: caps.long,
    maxShortReceipt: caps.short,
    slippageBps: DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
  };
}

describe("live: direct-pool withdrawal", () => {
  it("builds, asserts and simulates against MainNet", async () => {
    const st = await readMarketGateState(algod, 1, LP);
    expect(st.shares).toBeGreaterThan(0);
    expect(directCooldownGate(st.updatedAtSec, Math.floor(Date.now() / 1000))).toBeNull();

    // A tenth of the position, so the test does not depend on exact share maths.
    const shareAmount = BigInt(Math.floor(st.shares * 1e6 / 10));
    const inputs = await withdrawInputs(shareAmount);
    const r = await buildWithdraw({ algod, sender: LP, marketId: 1, shareAmount, ...inputs });

    expect(r.assertion.ok).toBe(true);
    expect(r.signingBudgetSec).toBeGreaterThan(8);

    // The chain's own figures, which is what the UI shows.
    const algoOut = r.receipt.fields.long_out;
    const usdcOut = r.receipt.fields.short_out;
    expect(r.receipt.eventType).toBe("v2_lp_withdrawn");
    expect(r.receipt.fields.shares_burned).toBe(shareAmount);
    expect(algoOut).toBeGreaterThan(BigInt(0));
    expect(usdcOut).toBeGreaterThan(BigInt(0));

    // The SDK quote is measurably off, in a documented direction. If this ever
    // stops being true the comments in strategy/group.ts need revisiting.
    const algoErr = Number(inputs.q.algoOut) / Number(algoOut) - 1;
    console.log(`withdraw ${shareAmount} shares -> ${algoOut} µALGO + ${usdcOut} µUSDC `
      + `(SDK quote said ${inputs.q.algoOut}/${inputs.q.usdcOut}, `
      + `${(algoErr * 100).toFixed(3)}% off), ${r.txns.length} txns`);
    expect(algoErr).toBeLessThan(0);
    console.log("checks:", r.assertion.checked);
  }, 90_000);

  it("rejects a group whose share amount was altered after display", async () => {
    const st = await readMarketGateState(algod, 1, LP);
    const shareAmount = BigInt(Math.floor(st.shares * 1e6 / 10));
    const inputs = await withdrawInputs(shareAmount);
    const r = await buildWithdraw({ algod, sender: LP, marketId: 1, shareAmount, ...inputs });

    // The same real group, re-checked against a DIFFERENT displayed amount and
    // a different oracle price: this is the substitution the assertion exists
    // to catch, and it is checked on real bytes rather than a fixture.
    const bad = assertWithdrawGroup(r.txns, {
      sender: LP, marketId: 1,
      shareAmount: shareAmount * BigInt(2),
      minAlgoMicro: BigInt(0), minUsdcMicro: BigInt(0),
      yieldRecallMode: BigInt(1),
      maxLongReceipt: inputs.maxLongReceipt, maxShortReceipt: inputs.maxShortReceipt,
      oracleMessage: new Uint8Array(133), oracleSignature: new Uint8Array(64),
      recall: inputs.recall,
    });
    expect(bad.ok).toBe(false);
    const codes = bad.findings.map((f) => f.code);
    expect(codes).toContain("share_amount");
    expect(codes).toContain("oracle_message");
    // The payout floors were real and non-zero, so claiming zero is caught too.
    expect(codes).toContain("min_algo");
    expect(codes).toContain("min_usdc");
  }, 90_000);
});

describe("live: direct-pool deposit", () => {
  it("builds, asserts and simulates a small two-sided deposit", async () => {
    const bal = await readBalances(algod, LP);
    // This wallet holds 0.827 USDC, so the deposit is sized under that.
    const usdcMicro = BigInt(500_000);
    const algoMicro = BigInt(500_000);

    const gates = marketGates({
      action: "deposit",
      state: await readMarketGateState(algod, 1, LP),
      balances: bal, nowSec: Math.floor(Date.now() / 1000),
      algoLegMicro: Number(algoMicro), usdcLegMicro: Number(usdcMicro),
      groupFeeMicro: 55_000, storagePayMicro: 0,
    });
    expect(gates).toEqual([]);

    const ctx = await readQuoteContext(algod, 1);
    const q = quoteDeposit(ctx, algoMicro, usdcMicro);
    expect(q.ok).toBe(true);

    const r = await buildDeposit({
      algod, sender: LP, marketId: 1,
      algoMicro, usdcMicro, storagePaymentMicro: BigInt(0),
      slippageBps: DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
    });
    expect(r.assertion.ok).toBe(true);
    expect(r.txns.length).toBe(6);
    expect(r.receipt.eventType).toBe("v2_lp_deposited");

    const minted = r.receipt.fields.shares_minted;
    expect(minted).toBeGreaterThan(BigInt(0));
    // The whole reason the receipt is the source of truth: a 1% floor taken
    // from this quote is unsatisfiable, because the quote is >1% high.
    const quoteErr = Number(q.sharesOut) / Number(minted) - 1;
    console.log(`deposit ${algoMicro} µALGO + ${usdcMicro} µUSDC -> ${minted} shares `
      + `(SDK quote said ${q.sharesOut}, ${(quoteErr * 100).toFixed(3)}% high)`);
    expect(quoteErr).toBeGreaterThan(0.01);
    console.log("checks:", r.assertion.checked);
  }, 90_000);
});

describe("live: the C-Vault's gates", () => {
  it("reads every global the gates depend on", async () => {
    const v = await readCvaVaultState(algod);
    expect(v.cooldownRounds).toBe(1200);
    expect(v.minWithdrawUsd).toBe(5);
    expect(v.mintSpreadBps).toBe(20);
    expect(v.burnSpreadBps).toBe(20);
    expect(v.maxNavAgeRounds).toBe(5);
    expect(v.activeMarkets).toEqual([1, 2]);
    expect(v.depositPaused).toBe(false);
    expect(v.withdrawPaused).toBe(false);

    // The NAV window, which no quote reports. If this is stale the vault
    // refuses a deposit, and the only remedy is a mark leg in the group.
    const status = await algod.status().do();
    const age = Number(status.lastRound) - v.lastNavUpdateRound;
    console.log(`C-Vault NAV is ${age} rounds old, limit ${v.maxNavAgeRounds}`);
  }, 90_000);
});
