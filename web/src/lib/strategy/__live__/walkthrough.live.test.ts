/**
 * A $10 C-Vault exit, every number measured on MainNet.
 *
 * Built to answer "run me through a concrete example" with real figures rather
 * than arithmetic. Nothing is signed.
 */
import { describe, it } from "vitest";
import algosdk from "algosdk";
import { buildV2SwapExactInTransactions, decodeReceipt } from "@pdex/sdk";
import { simulateGroup } from "../../perpsGroup";
import { readCvaSnapshot } from "../cvaSnapshot";
import { buildCvaWithdraw } from "../cvaGroup";
import { readQuoteContext, readRecallContext } from "../quote";
import { getOraclePayload } from "../../perpsOracle";
import { PEX_APPS, PEX_ASSETS } from "../../perps";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const HOLDER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";
const SLIPPAGE_BPS = 100;
const f6 = (v: bigint | number) => (Number(v) / 1e6).toFixed(6);
const f2 = (v: bigint | number) => (Number(v) / 1e6).toFixed(2);

describe("walkthrough: withdraw $10 from the C-Vault, all USDC", () => {
  it("prints the full ledger", async () => {
    const snap = await readCvaSnapshot(algod);
    const want = 10;
    const shareAmount = BigInt(Math.floor(want / snap.navPerShare * 1e6));

    console.log(`\nYou ask for $${want.toFixed(2)}.`);
    console.log(`NAV per share $${snap.navPerShare.toFixed(6)} -> burn ${f6(shareAmount)} shares\n`);

    // ── Group A: the vault exit ──
    const a = await buildCvaWithdraw({
      algod, sender: HOLDER, snapshot: snap, shareAmount,
      maxLongReceipt: BigInt(500_000_000), maxShortReceipt: BigInt(500_000_000),
      slippageBps: SLIPPAGE_BPS,
    });
    const algoOut = a.receipt.fields.long_out!;
    const usdcOut = a.receipt.fields.short_out!;
    const feeA = a.txns.reduce((s, t) => s + Number(t.fee), 0);

    // The floor the contract guarantees, which is what the swap is sized to.
    const floorAlgo = algoOut * BigInt(10_000 - SLIPPAGE_BPS) / BigInt(10_000);

    console.log(`GROUP A  vault exit          ${a.txns.length} txns, ${feeA} µALGO fee`);
    console.log(`  pays out                   ${f6(algoOut)} ALGO + ${f6(usdcOut)} USDC`);
    console.log(`  on-chain floors            ${f6(floorAlgo)} ALGO + `
      + `${f6(usdcOut * BigInt(9900) / BigInt(10000))} USDC`);
    console.log(`  route                      market ${a.route?.marketId}\n`);

    // ── Group B: convert the ALGO leg ──
    const ctx = await readQuoteContext(algod, 1);
    const rc = await readRecallContext(algod, ctx);
    const sp = await algod.getTransactionParams().do();
    sp.fee = sp.minFee; sp.flatFee = true;
    const so = await getOraclePayload(PEX_APPS.swapOps, 1);
    const swapRefs = {
      sender: HOLDER, marketId: 1,
      tokenInAssetId: PEX_ASSETS.algo,
      yieldRecallMode: 1,
      maxOutputReceiptAmount: BigInt(2_000_000_000),
      marketYieldRegistry: rc.registry,
      oracleMessage: so.message, oracleSignature: so.signature,
      indexAssetId: PEX_ASSETS.algo,
      longAssetId: PEX_ASSETS.algo, shortAssetId: PEX_ASSETS.usdc,
      v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
      v2TradingAppId: PEX_APPS.trading, v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
      v2OrderOpsAppId: PEX_APPS.orderOps, v2AdminOpsAppId: PEX_APPS.adminOps,
      v2SwapOpsAppId: PEX_APPS.swapOps, v2AdminControlAppId: PEX_APPS.adminControl,
      v2MarketYieldVaultAppId: PEX_APPS.marketYieldVault,
      v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
    };
    const b = buildV2SwapExactInTransactions({
      ...swapRefs, amountIn: floorAlgo, minAmountOut: 0,
    } as never, sp) as algosdk.Transaction[];
    const rb = await simulateGroup(algod, b);
    const feeB = b.reduce((s, t) => s + Number(t.fee), 0);

    let swapOut = BigInt(0), swapFee = BigInt(0);
    for (const log of rb.logs ?? []) {
      if (Buffer.from(log.slice(0, 4)).toString("hex") !== "151f7c75") continue;
      const bb = log.slice(4); const len = (bb[0] << 8) | bb[1];
      try {
        const rec = decodeReceipt(bb.slice(2, 2 + len)) as unknown as
          { eventType?: string; fields?: Record<string, bigint> };
        if (rec.eventType === "v2_swap_executed") {
          swapOut = BigInt(String(rec.fields?.amount_out ?? 0));
          swapFee = BigInt(String(rec.fields?.fee_amount ?? 0));
        }
      } catch { /* not a receipt */ }
    }

    console.log(`GROUP B  swap ALGO -> USDC   ${b.length} txns, ${feeB} µALGO fee`
      + `${rb.ok ? "" : "  [SIMULATION FAILED]"}`);
    console.log(`  swaps in                   ${f6(floorAlgo)} ALGO  (the FLOOR, not the ${f6(algoOut)} actual)`);
    console.log(`  swaps out                  ${f6(swapOut)} USDC   (swap fee ${swapFee} µ)`);
    const dust = algoOut - floorAlgo;
    console.log(`  ALGO left over             ${f6(dust)} ALGO  <- the dust\n`);

    const totalUsdc = usdcOut + swapOut;
    const totalFeeAlgo = feeA + feeB;
    console.log(`YOU RECEIVE                  ${f2(totalUsdc)} USDC + ${f6(dust)} ALGO`);
    console.log(`  one wallet prompt covering ${a.txns.length + b.length} txns in 2 groups`);
    console.log(`  network fees               ${(totalFeeAlgo / 1e6).toFixed(6)} ALGO`);
    const algoUsd = Number(swapOut) / Number(floorAlgo);
    console.log(`  dust in dollars            $${(Number(dust) / 1e6 * algoUsd).toFixed(4)} `
      + `(at the swap's own rate $${algoUsd.toFixed(4)}/ALGO)`);
    console.log(`  fees in dollars            $${(totalFeeAlgo / 1e6 * algoUsd).toFixed(4)}`);
    const got = Number(totalUsdc) / 1e6 + Number(dust) / 1e6 * algoUsd;
    console.log(`\n  asked $${want.toFixed(2)}, hold $${got.toFixed(4)} afterwards, `
      + `minus $${(totalFeeAlgo / 1e6 * algoUsd).toFixed(4)} of fees`);
  }, 240_000);
});
