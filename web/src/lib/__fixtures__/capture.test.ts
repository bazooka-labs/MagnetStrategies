// Regenerates src/lib/__fixtures__/perpsGroups.json from live MainNet.
//
//   CAPTURE=1 npx vitest run src/lib/__fixtures__/capture.test.ts
//
// Skipped on a normal `npm test` run: it needs the network, and the fixture it
// writes is committed precisely so the assertion tests do NOT.
//
// ── Why a captured fixture rather than hand-built objects ────────────────────
// The first version of perpsGroup.test.ts built its groups as object literals
// shaped the way I believed the SDK shaped them. That is the B1 mistake with a
// different mask: a test that does not exercise what production exercises. It
// also meant the ONLY assertion the write path calls —
// `assertOpenWithTakeProfit` — had no coverage at all, because writing a
// 9-transaction group by hand is tedious enough that I did not.
//
// These are real `@pdex/sdk` 0.6.3 groups, serialised with
// `encodeUnsignedTransaction` and decoded back into genuine algosdk
// Transactions by the tests, so `txID()`, fees and field types are all real.
//
// Regenerate when the SDK version changes, when the build call in
// perpsClient.ts changes, or when a market's assets change.

import { it } from "vitest";
import fs from "node:fs";
import algosdk from "algosdk";
import { buildV2MarketOpenWithAttachedOrdersTransactions } from "@pdex/sdk/transactions";
import { V2_ORDER_TARGET } from "@pdex/sdk";
import { readMarketState } from "../perpsReads";
import { getOraclePayload } from "../perpsOracle";
import { installProtocolManifest } from "../perpsManifest";
import { quoteOpen, confirmCeiling, acceptableForClose } from "../perpsQuote";
import {
  BUILDER_ADDRESS, CHILD_KEEPER_FEE_USDC, COLLATERAL_ASSET_ID,
  DEFAULT_SLIPPAGE_BPS, PEX_APPS, POSITION_BUILDER_FEE_BPS,
} from "../perps";

const micro = (x: number) => BigInt(Math.round(x * 1e6));
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

const CAPTURE = !!process.env.CAPTURE;

it.skipIf(!CAPTURE)("captures real SDK groups", async () => {
  await installProtocolManifest();
  const algod = new algosdk.Algodv2("", "https://mainnet-api.4160.nodely.dev", "");
  const sp = await algod.getTransactionParams().do();
  const out: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    note: "Real @pdex/sdk 0.6.3 output against MainNet. Regenerate with scripts/capture-perps-groups.ts.",
    groups: {},
  };

  for (const [marketId, side] of [[1, "long"], [1, "short"], [2, "long"], [2, "short"]] as const) {
    const [state, oracle] = await Promise.all([
      readMarketState(algod, marketId), getOraclePayload(PEX_APPS.trading, marketId),
    ]);
    const sender = BUILDER_ADDRESS;
    const collateralUsd = 50;
    const base = {
      state, oracle, side, collateralUsd, builderAddress: BUILDER_ADDRESS,
      collateralAssetId: COLLATERAL_ASSET_ID, slippageBps: DEFAULT_SLIPPAGE_BPS,
      builderFeeBps: POSITION_BUILDER_FEE_BPS,
    };
    const conf = confirmCeiling(base);
    if (!conf) { console.log(`skip m${marketId} ${side}: no ceiling`); continue; }
    const notionalUsd = conf.notionalUsd;
    const probe = quoteOpen({ ...base, notionalUsd });
    if (!probe.ok) { console.log(`skip m${marketId} ${side}: quote not ok`); continue; }

    // A comfortably non-crossed take-profit: 25% beyond entry in the profitable
    // direction, so the captured group is a realistic, valid one.
    const tp12 = side === "long"
      ? (probe.entryPrice12 * BigInt(125)) / BigInt(100)
      : (probe.entryPrice12 * BigInt(75)) / BigInt(100);
    const tpAcceptable = acceptableForClose(tp12, side, DEFAULT_SLIPPAGE_BPS);
    const baseOrderId = BigInt(1);

    const group = buildV2MarketOpenWithAttachedOrdersTransactions({
      sender, marketId, collateralAssetId: COLLATERAL_ASSET_ID,
      side: side === "long" ? BigInt(1) : BigInt(2),
      collateralAmount: micro(collateralUsd), sizeUsdDelta: micro(notionalUsd),
      acceptablePrice: probe.acceptablePrice12,
      oracleMessage: oracle.message, oracleSignature: oracle.signature,
      builderFee: { builderAddress: BUILDER_ADDRESS, builderFeeBps: BigInt(POSITION_BUILDER_FEE_BPS) },
      baseOrderId, targetKind: V2_ORDER_TARGET.PAIR,
      indexAssetId: Number(state.core.index_asset_id),
      longAssetId: Number(state.core.long_asset_id),
      shortAssetId: Number(state.core.short_asset_id),
      takeProfit: {
        triggerPrice: tp12, acceptablePrice: tpAcceptable,
        sizeUsdDelta: micro(notionalUsd), collateralAmount: BigInt(0),
        keeperFeeAssetId: COLLATERAL_ASSET_ID, keeperFeeAmount: micro(CHILD_KEEPER_FEE_USDC),
        outputSwapMode: BigInt(0), minPrimaryOutputAmount: BigInt(0),
        minSecondaryOutputAmount: BigInt(0), timeInForce: BigInt(0), expiryTime: BigInt(0),
      },
      v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
      v2TradingAppId: PEX_APPS.trading, v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
      v2OrderOpsAppId: PEX_APPS.orderOps,
      v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
      v2AdminControlAppId: PEX_APPS.adminControl,
    }, sp) as unknown[];

    const txns = group.map((t) => ((t as { txn?: algosdk.Transaction }).txn ?? t) as algosdk.Transaction);
    console.log(`m${marketId} ${side}: ${txns.length} txns [${txns.map((t) => t.type).join(",")}] fee=${
      txns.reduce((a, t) => a + Number(t.fee), 0)}`);

    (out.groups as Record<string, unknown>)[`m${marketId}_${side}`] = {
      marketId, side, sender, collateralUsd, notionalUsd,
      collateralAmountMicro: String(micro(collateralUsd)),
      sizeUsdDeltaMicro: String(micro(notionalUsd)),
      acceptablePrice12: String(probe.acceptablePrice12),
      executionPrice12: String(probe.executionPrice12),
      entryPrice12: String(probe.entryPrice12),
      indexPrice12: String(oracle.indexPrice12),
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      oracleMessage: b64(oracle.message), oracleSignature: b64(oracle.signature),
      tpTriggerPrice12: String(tp12), tpAcceptablePrice12: String(tpAcceptable),
      tpKeeperFeeMicro: String(micro(CHILD_KEEPER_FEE_USDC)),
      baseOrderId: String(baseOrderId),
      txns: txns.map((t) => b64(algosdk.encodeUnsignedTransaction(t))),
    };
  }
  fs.writeFileSync(new URL("./perpsGroups.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("written");
}, 300000);
