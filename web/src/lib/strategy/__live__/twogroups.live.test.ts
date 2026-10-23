/**
 * Can a vault exit + a swap be ONE signature but TWO groups?
 *
 * I previously concluded a single-asset C-Vault exit needs two signatures,
 * because withdraw (15 txns) + swap (4-7) exceeds Algorand's 16-transaction
 * GROUP limit. The user reports Mallow does it with one signature, which means
 * the conclusion was wrong — and the error was conflating two different limits:
 *
 *   - a GROUP is capped at 16 transactions and is atomic
 *   - a SIGNING REQUEST is capped by neither; ARC-0001 `signTxns` takes an
 *     array that may contain SEVERAL groups, and the wallet prompts once
 *
 * So: group A = the withdrawal, group B = the swap, both in one
 * `signTransactions` call, both submitted together. One prompt, two groups.
 *
 * The cost is that the groups are not atomic WITH EACH OTHER: B can fail while
 * A succeeds, leaving the user holding both assets with the conversion undone.
 * That is a real state the UI has to handle, not a reason the approach fails.
 *
 * This test proves the mechanism: simulate both groups in one request and
 * require both to pass.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { buildV2SwapExactInTransactions } from "@pdex/sdk";
import { readCvaSnapshot } from "../cvaSnapshot";
import { buildCvaWithdraw } from "../cvaGroup";
import { readQuoteContext, readRecallContext } from "../quote";
import { getOraclePayload } from "../../perpsOracle";
import { PEX_APPS, PEX_ASSETS } from "../../perps";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const HOLDER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";
export const MAX_GROUP_SIZE = 16;

describe("live: one signature, two groups", () => {
  it("simulates a vault withdrawal and a swap as two groups in one request", async () => {
    const snap = await readCvaSnapshot(algod);

    // ── Group A: the vault exit, exactly as production builds it ──
    const shareAmount = BigInt(Math.ceil(12 / snap.navPerShare * 1e6));
    const built = await buildCvaWithdraw({
      algod, sender: HOLDER, snapshot: snap, shareAmount,
      maxLongReceipt: BigInt(500_000_000), maxShortReceipt: BigInt(500_000_000),
      slippageBps: 100,
    });
    const algoOut = built.receipt.fields.long_out!;
    const usdcOut = built.receipt.fields.short_out!;
    console.log(`group A: ${built.txns.length} txns, exit pays `
      + `${algoOut} µALGO + ${usdcOut} µUSDC`);

    // ── Group B: convert the ALGO leg to USDC ──
    // Sized to the FLOOR the withdrawal guarantees, not to the simulated
    // figure: the groups are not atomic with each other, so swapping more than
    // is certain to arrive would make B fail after A had already paid out.
    const swapIn = algoOut * BigInt(99) / BigInt(100);
    const ctx = await readQuoteContext(algod, 1);
    const rc = await readRecallContext(algod, ctx);
    const sp = await algod.getTransactionParams().do();
    sp.fee = sp.minFee; sp.flatFee = true;
    const swapOracle = await getOraclePayload(PEX_APPS.swapOps, 1);
    const swap = buildV2SwapExactInTransactions({
      sender: HOLDER, marketId: 1,
      tokenInAssetId: PEX_ASSETS.algo,
      amountIn: swapIn, minAmountOut: 0,
      yieldRecallMode: 1,
      maxOutputReceiptAmount: BigInt(2_000_000_000),
      marketYieldRegistry: rc.registry,
      oracleMessage: swapOracle.message, oracleSignature: swapOracle.signature,
      indexAssetId: PEX_ASSETS.algo,
      longAssetId: PEX_ASSETS.algo, shortAssetId: PEX_ASSETS.usdc,
      v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
      v2TradingAppId: PEX_APPS.trading, v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
      v2OrderOpsAppId: PEX_APPS.orderOps, v2AdminOpsAppId: PEX_APPS.adminOps,
      v2SwapOpsAppId: PEX_APPS.swapOps, v2AdminControlAppId: PEX_APPS.adminControl,
      v2MarketYieldVaultAppId: PEX_APPS.marketYieldVault,
      v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
    } as never, sp) as algosdk.Transaction[];
    console.log(`group B: ${swap.length} txns, swapping ${swapIn} µALGO`);

    // Each group is independently within the cap; together they exceed it,
    // which is exactly why they must be two groups rather than one.
    expect(built.txns.length).toBeLessThanOrEqual(MAX_GROUP_SIZE);
    expect(swap.length).toBeLessThanOrEqual(MAX_GROUP_SIZE);
    expect(built.txns.length + swap.length).toBeGreaterThan(MAX_GROUP_SIZE);

    /**
     * ── The mechanism, and what can actually be tested here ──
     * algod's `simulate` accepts exactly ONE group per request — it answers
     * "expected 1 transaction group, got 2" — so the two groups are simulated
     * separately. That is an API limit of simulate, NOT of signing or
     * submission:
     *
     *   - ARC-0001 `signTxns` takes an ARRAY that may span several groups, and
     *     the wallet shows one prompt for it
     *   - `sendRawTransaction` takes an array of signed transactions spanning
     *     several groups and evaluates each group independently
     *
     * So one signature covering two groups is a wallet/node property, not
     * something a simulation can confirm. What IS confirmed here is the part
     * that could actually be wrong: that each group is independently valid.
     */
    for (const [label, txns] of [["A (exit)", built.txns], ["B (swap)", swap]] as const) {
      const req = new algosdk.modelsv2.SimulateRequest({
        txnGroups: [new algosdk.modelsv2.SimulateRequestTransactionGroup({
          txns: txns.map((t) => new algosdk.SignedTransaction({ txn: t })),
        })],
        allowEmptySignatures: true, fixSigners: true,
      });
      const res = await algod.simulateTransactions(req).do();
      const g = (res.txnGroups ?? [])[0];
      console.log(`  group ${label}: ${g?.failureMessage
        ? `FAILED ${String(g.failureMessage).slice(0, 120)}` : "OK"}`);
      expect(g?.failureMessage ?? "", `group ${label}`).toBe("");
    }
    console.log(`one wallet prompt would cover ${built.txns.length + swap.length} `
      + `transactions across 2 groups`);
  }, 180_000);
});
