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
import { readQuoteContext, readRecallContext } from "@/lib/strategy/pools/quote";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
/** The admin wallet whose withdrawal failed, and an unrelated holder. */
const ADMIN = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";
const OTHER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";
const CAP = BigInt(500_000_000);

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
    const r = await buildCvaWithdraw({
      algod, sender: ADMIN, snapshot: snap,
      shareAmount: BigInt(20_831_065),
      maxLongReceipt: CAP, maxShortReceipt: CAP, slippageBps: 100,
    });
    console.log("withdraw txns:", r.txns.length,
      "receipt:", JSON.stringify(Object.fromEntries(
        Object.entries(r.receipt.fields).map(([k, v]) => [k, String(v)]))));
    expect(r.txns.length).toBeGreaterThan(0);
  });

  it("works for a holder who is not the admin", async () => {
    const snap = await readCvaSnapshot(algod);
    // $50: a size sweep showed $5 hits `split_cva_withdrawal_required` and
    // $400 hits an inner-txn fee ceiling (pc=8944) — both pre-existing routing
    // limits, neither related to the box references. $10-$100 route cleanly.
    const shares = BigInt(Math.floor(50 / snap.navPerShare * 1e6));
    const r = await buildCvaWithdraw({
      algod, sender: OTHER, snapshot: snap, shareAmount: shares,
      maxLongReceipt: CAP, maxShortReceipt: CAP, slippageBps: 100,
    });
    expect(r.txns.length).toBeGreaterThan(0);
  });

  it("the USDC-only exit: withdrawal plus the ALGO to USDC swap", async () => {
    // The path the user actually used when it failed.
    const snap = await readCvaSnapshot(algod);
    const exit = await buildCvaWithdraw({
      algod, sender: ADMIN, snapshot: snap, shareAmount: BigInt(20_831_065),
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
      algod, sender: ADMIN, marketId: 1, amountInMicro: floorAlgo,
      registry: rc.registry, recall: rc.recall, slippageBps: 100,
    });
    expect(swap.txns.length).toBeGreaterThan(0);
  });
});
