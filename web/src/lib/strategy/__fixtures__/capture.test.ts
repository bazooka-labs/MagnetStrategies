// Regenerates src/lib/strategy/__fixtures__/groups.json from live MainNet.
//
//   CAPTURE=1 npx vitest run src/lib/strategy/__fixtures__/capture.test.ts
//
// Skipped on a normal `npm test` run: it needs the network, and the fixture it
// writes is committed precisely so the assertion tests do NOT.
//
// Same reasoning as `capture.test.ts`: a test that builds its groups as object
// literals is testing my belief about the SDK, not the SDK. Every mistake this
// path made during construction — the mandatory yield registry, the two
// non-zero receipt caps, the 1.65% quote bias, the fifteen recall resources —
// was invisible to a hand-built group and obvious in a real one.
//
// Regenerate when the SDK version changes, when the build calls in
// strategy/group.ts change, or when a market's assets change.

import { it } from "vitest";
import fs from "node:fs";
import algosdk from "algosdk";
import {
  buildV2DepositLiquidityTransactions,
  buildV2WithdrawLiquidityTransactions,
} from "@pdex/sdk/transactions";
import { readQuoteContext, readRecallContext, quoteWithdraw, recallCaps } from "@/lib/strategy/pools/quote";
import { installProtocolManifest } from "@/lib/strategy/pex/manifest";
import { PEX_APPS, PEX_ASSETS } from "@/lib/strategy/pex/config";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const CAPTURE = !!process.env.CAPTURE;

/** A real market-1 LP: 0.92902 shares, deposited 2026-09-09. */
const LP = "A4YW55ZEC2TTIN2TEVN56IRVGLWQYQRUNJTPG37OTWE4EJWNAH3EUKHZKA";

it.skipIf(!CAPTURE)("captures real SDK liquidity groups", async () => {
  await installProtocolManifest();
  const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
  const sp = await algod.getTransactionParams().do();
  // Mirror liquidityGroup's fee pinning, for the reason capture.test.ts gives:
  // a fixture that builds differently from production is not a capture.
  sp.fee = sp.minFee;
  sp.flatFee = true;

  const out: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    note: "Real @pdex/sdk 0.6.6 output against MainNet. Regenerate with CAPTURE=1.",
    groups: {},
  };

  const enc = (g: unknown[]) => g
    .map((t) => ((t as { txn?: algosdk.Transaction }).txn ?? t) as algosdk.Transaction)
    .map((t) => b64(algosdk.encodeUnsignedTransaction(t)));

  for (const marketId of [1, 2] as const) {
    const ctx = await readQuoteContext(algod, marketId);
    const refs = {
      indexAssetId: marketId === 2 ? PEX_ASSETS.btcIndex : PEX_ASSETS.algo,
      longAssetId: PEX_ASSETS.algo,
      shortAssetId: PEX_ASSETS.usdc,
      v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
      v2TradingAppId: PEX_APPS.trading, v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
      v2OrderOpsAppId: PEX_APPS.orderOps, v2AdminOpsAppId: PEX_APPS.adminOps,
      v2AdminControlAppId: PEX_APPS.adminControl,
      v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
    };

    const algoMicro = BigInt(500_000);
    const usdcMicro = BigInt(500_000);
    // The floor a real build uses comes from the chain's receipt; a fixture
    // only needs a realistic non-zero value, and the assertion is checked
    // against whatever is captured here.
    const minShares = BigInt(479_681);
    const deposit = buildV2DepositLiquidityTransactions({
      sender: LP, marketId, longAmount: algoMicro, shortAmount: usdcMicro,
      storagePaymentMicroAlgo: BigInt(0), minMarketShares: minShares,
      oracleMessage: ctx.oracle.message, oracleSignature: ctx.oracle.signature,
      ...refs,
    } as never, sp) as unknown[];

    const shareAmount = BigInt(92_902);
    const wq = quoteWithdraw(ctx, shareAmount);
    const caps = recallCaps(wq);
    const rc = await readRecallContext(algod, ctx);
    const minAlgo = BigInt(232_310);
    const minUsdc = BigInt(79_057);
    const withdraw = buildV2WithdrawLiquidityTransactions({
      sender: LP, marketId, shareAmount,
      minLongAmount: minAlgo, minShortAmount: minUsdc,
      yieldRecallMode: BigInt(1),
      maxLongReceiptAmount: caps.long, maxShortReceiptAmount: caps.short,
      marketYieldRegistry: rc.registry,
      oracleMessage: ctx.oracle.message, oracleSignature: ctx.oracle.signature,
      ...refs,
    } as never, sp) as unknown[];

    const dt = deposit.map((t) => ((t as { txn?: algosdk.Transaction }).txn ?? t) as algosdk.Transaction);
    const wt = withdraw.map((t) => ((t as { txn?: algosdk.Transaction }).txn ?? t) as algosdk.Transaction);
    console.log(`m${marketId} deposit: ${dt.length} txns [${dt.map((t) => t.type).join(",")}] `
      + `fee=${dt.reduce((a, t) => a + Number(t.fee), 0)} | withdraw: ${wt.length} txns `
      + `fee=${wt.reduce((a, t) => a + Number(t.fee), 0)}`);

    (out.groups as Record<string, unknown>)[`m${marketId}`] = {
      marketId, sender: LP,
      deposit: {
        algoMicro: String(algoMicro), usdcMicro: String(usdcMicro),
        minShares: String(minShares), storagePaymentMicro: "0",
        txns: enc(deposit),
      },
      withdraw: {
        shareAmount: String(shareAmount),
        minAlgoMicro: String(minAlgo), minUsdcMicro: String(minUsdc),
        yieldRecallMode: "1",
        maxLongReceipt: String(caps.long), maxShortReceipt: String(caps.short),
        recall: rc.recall,
        txns: enc(withdraw),
      },
      oracleMessageB64: b64(ctx.oracle.message),
      oracleSignatureB64: b64(ctx.oracle.signature),
    };
  }

  fs.writeFileSync(
    "src/lib/strategy/__fixtures__/groups.json",
    JSON.stringify(out, null, 1) + "\n",
  );
});
