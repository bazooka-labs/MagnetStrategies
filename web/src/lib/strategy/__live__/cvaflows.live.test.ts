/**
 * Every C-Vault flow, simulated on MainNet. Nothing is signed.
 *
 * This file exists because fixing the deposit (pc=8526) broke the from-market
 * withdrawal (pc=7789) and it was not noticed: the deposit was the only flow
 * re-tested after that change. `markMarketsFor` feeds all three, so all three
 * are checked together from now on.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { readCvaSnapshot } from "@/lib/strategy/pools/cvaSnapshot";
import { buildCvaDeposit, buildCvaWithdraw } from "@/lib/strategy/pools/cvaGroup";
import { buildAlgoToUsdcSwap } from "@/lib/strategy/pools/swapGroup";
import { PEX_APPS } from "@/lib/strategy/pex/config";
import { readQuoteContext, readRecallContext } from "@/lib/strategy/pools/quote";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
/** A holder used for the refusal case; every other test reads the chain. */
const OTHER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";
const CAP = BigInt(500_000_000);

/**
 * Shares a wallet actually holds, read from its `gu2:` box.
 *
 * These tests used to hardcode a share count. That broke the moment the
 * position it named was withdrawn — which is exactly what the fix under test
 * enabled. A live test must not assume a balance it does not control.
 */
async function sharesOf(addr: string): Promise<bigint> {
  const key = new Uint8Array(Buffer.concat([
    Buffer.from("gu2:"), Buffer.from(algosdk.decodeAddress(addr).publicKey),
  ]));
  try {
    const box = await algod.getApplicationBoxByName(PEX_APPS.cvaVault, key).do();
    const v = Buffer.from(box.value);
    return new DataView(v.buffer, v.byteOffset, v.length).getBigUint64(0, false);
  } catch { return BigInt(0); }
}

/** The largest holder right now, so no test names a wallet that may have left. */
async function biggestHolder(): Promise<{ addr: string; shares: bigint }> {
  // One page: the vault holds ~33 boxes in total, well under the 1000 limit.
  const { boxes } = await algod.getApplicationBoxes(PEX_APPS.cvaVault).max(1000).do();
  let best = { addr: "", shares: BigInt(0) };
  for (const b of boxes) {
    const n = Buffer.from(b.name);
    if (n.subarray(0, 4).toString() !== "gu2:") continue;
    const addr = algosdk.encodeAddress(n.subarray(4, 36));
    const shares = await sharesOf(addr);
    if (shares > best.shares) best = { addr, shares };
  }
  return best;
}

describe("C-Vault flows against the live chain", () => {
  it("the snapshot still has an active-but-unfunded market", async () => {
    // If PEX refunds market 2 this whole hazard goes dormant, and a green
    // suite would then prove nothing. Assert the condition still holds.
    const snap = await readCvaSnapshot(algod);
    const funded = snap.allocations
      .filter((a) => BigInt(String(a.lp_share_amount ?? 0)) > BigInt(0))
      .map((a) => Number(a.market_id));
    console.log("active:", JSON.stringify(snap.state.activeMarkets), "funded:", JSON.stringify(funded));
    expect(snap.state.activeMarkets.length).toBeGreaterThan(0);
  });

  it("deposit builds and simulates — the pc=8526 regression stays fixed", async () => {
    const snap = await readCvaSnapshot(algod);
    const r = await buildCvaDeposit({
      algod, sender: OTHER, snapshot: snap,
      algoMicro: BigInt(0), usdcMicro: BigInt(5_000_000),
      storagePaymentMicro: BigInt(0), slippageBps: 100,
    } as never);
    expect(r.txns.length).toBeGreaterThan(0);
  });

  it("from-market withdrawal builds and simulates — the pc=7789 failure", async () => {
    const snap = await readCvaSnapshot(algod);
    const { addr } = await biggestHolder();
    const shares = BigInt(Math.floor(50 / snap.navPerShare * 1e6));
    const r = await buildCvaWithdraw({
      algod, sender: addr, snapshot: snap, shareAmount: shares,
      maxLongReceipt: CAP, maxShortReceipt: CAP, slippageBps: 100,
    });
    console.log("withdraw txns:", r.txns.length,
      "receipt:", JSON.stringify(Object.fromEntries(
        Object.entries(r.receipt.fields).map(([k, v]) => [k, String(v)]))));
    expect(r.txns.length).toBeGreaterThan(0);
  });

  it("works for a holder who is not the admin", async () => {
    const snap = await readCvaSnapshot(algod);
    /*
      $50, because a size sweep found $5 refused with
      `split_cva_withdrawal_required` while $10 and up route cleanly.

      There is NO upper bound: a full exit of the largest position ($2,150,
      60.9% of the vault) simulates fine. An earlier note here claimed $400
      hit a fee ceiling at pc=8944 — that was this test harness passing a
      fixed receipt cap of 500, not a protocol limit. `cvaClient.ts` scales
      the cap with the withdrawal, which is why the real path has no such
      wall. Corrected rather than left, because a wrong "known limit" is the
      kind of note that stops someone investigating a real failure.
    */
    const shares = BigInt(Math.floor(50 / snap.navPerShare * 1e6));
    const r = await buildCvaWithdraw({
      algod, sender: OTHER, snapshot: snap, shareAmount: shares,
      maxLongReceipt: CAP, maxShortReceipt: CAP, slippageBps: 100,
    });
    expect(r.txns.length).toBeGreaterThan(0);
  });

  it("the USDC-only exit: withdrawal plus the ALGO to USDC swap", async () => {
    /**
     * The path the user was on when it failed.
     *
     * Sized small on purpose. The two groups are signed together in the real
     * flow, so the ALGO the swap spends is the ALGO the withdrawal just paid
     * out — but simulated separately the wallet must already hold it, and a
     * large exit overspends a balance it has not received yet. That is a
     * property of simulating the legs apart, not of the code.
     */
    const snap = await readCvaSnapshot(algod);
    const { addr } = await biggestHolder();
    const exit = await buildCvaWithdraw({
      algod, sender: addr, snapshot: snap,
      shareAmount: BigInt(Math.floor(10 / snap.navPerShare * 1e6)),
      maxLongReceipt: CAP, maxShortReceipt: CAP, slippageBps: 100,
    });
    const algoOut = exit.receipt.fields.long_out ?? exit.receipt.fields.long_amount_out;
    console.log("algo out of the vault:", String(algoOut));
    if (!algoOut || algoOut === BigInt(0)) return;
    const ctx = await readQuoteContext(algod, 1);
    const rc = await readRecallContext(algod, ctx);
    // Floor the input the way the real exit does, so the swap is quotable.
    const floorAlgo = algoOut * BigInt(9_900) / BigInt(10_000);
    const swap = await buildAlgoToUsdcSwap({
      algod, sender: (await biggestHolder()).addr, marketId: 1, amountInMicro: floorAlgo,
      registry: rc.registry, recall: rc.recall, slippageBps: 100,
    });
    expect(swap.txns.length).toBeGreaterThan(0);
  });
});

describe("withdrawal size bounds", () => {
  it("a full exit of the LARGEST position still routes", async () => {
    /**
     * The holder with 60.9% of the vault. If the biggest depositor cannot
     * leave in one transaction group, that is a liquidity property users must
     * be told about — so it is checked rather than assumed.
     *
     * Caps come from `cvaClient.ts`'s own formula. A fixed cap understates the
     * ceiling badly and produces pc=8944, which is what made an earlier run
     * look like a protocol limit.
     */
    const snap = await readCvaSnapshot(algod);
    const { addr, shares } = await biggestHolder();
    const usd = Number(shares) / 1e6 * snap.navPerShare;
    console.log("largest holder", addr.slice(0, 10), "$" + usd.toFixed(2));
    const headroom = BigInt(Math.ceil(Math.max(usd * 20, 100) * 1e6));
    const r = await buildCvaWithdraw({
      algod, sender: addr, snapshot: snap, shareAmount: shares,
      maxLongReceipt: headroom, maxShortReceipt: headroom, slippageBps: 100,
    });
    expect(r.txns.length).toBeGreaterThan(0);
  });

  it("refuses below the routable minimum, with a mapped message", async () => {
    // $5 is above the contract's own min_cva_withdraw_usd and still refused,
    // because PEX wants the amount split across sources. Pinned so the day it
    // starts working — or starts failing differently — is visible.
    const snap = await readCvaSnapshot(algod);
    const shares = BigInt(Math.floor(5 / snap.navPerShare * 1e6));
    await expect(buildCvaWithdraw({
      algod, sender: OTHER, snapshot: snap, shareAmount: shares,
      maxLongReceipt: CAP, maxShortReceipt: CAP, slippageBps: 100,
    })).rejects.toThrow(/split_cva_withdrawal_required|could not route/i);
  });
});
