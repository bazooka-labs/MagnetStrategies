/**
 * An ALGO-collateral open, built and ASSERTED against MainNet. Nothing signed.
 *
 * This is the end-to-end check that the two changes actually unblock ALGO:
 * the leverage assertion priced from the signed message, and the pool assets
 * added to the `foreign_asset` enumeration.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { buildV2OpenOrIncreaseWithStorageTransactions } from "@pdex/sdk/transactions";
import { readMarketState } from "@/lib/strategy/pex/reads";
import { getOraclePayload } from "@/lib/strategy/pex/oracle";
import { installProtocolManifest } from "@/lib/strategy/pex/manifest";
import { assertOpenGroup, openShapeFor } from "@/lib/strategy/pex/group";
import { quoteOpen } from "@/lib/strategy/pex/quote";
import {
  PEX_APPS, PEX_ASSETS, BUILDER_ADDRESS, POSITION_BUILDER_FEE_BPS, DEFAULT_SLIPPAGE_BPS,
} from "@/lib/strategy/pex/config";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const USER = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

async function openFor(collateralAssetId: number, collateralMicro: bigint) {
  await installProtocolManifest();
  const state = await readMarketState(algod, 1);
  const oracle = await getOraclePayload(PEX_APPS.trading, 1);
  const sp = await algod.getTransactionParams().do();
  sp.fee = sp.minFee; sp.flatFee = true;

  const quote = quoteOpen({
    state, oracle, side: "long",
    collateralAmountMicro: collateralMicro, notionalUsd: 18,
    builderAddress: BUILDER_ADDRESS, collateralAssetId,
    algoPrice12: oracle.indexPrice12, slippageBps: DEFAULT_SLIPPAGE_BPS,
  });
  const acceptable = quote.acceptablePrice12;
  const txns = buildV2OpenOrIncreaseWithStorageTransactions({
    sender: USER, marketId: 1, collateralAssetId, side: BigInt(1),
    collateralAmount: collateralMicro, sizeUsdDelta: BigInt(18_000_000),
    acceptablePrice: acceptable,
    oracleMessage: oracle.message, oracleSignature: oracle.signature,
    builderFee: { builderAddress: BUILDER_ADDRESS, builderFeeBps: BigInt(POSITION_BUILDER_FEE_BPS) },
    baseOrderId: BigInt(1), targetKind: 0,
    indexAssetId: Number(state.core.index_asset_id),
    longAssetId: Number(state.core.long_asset_id),
    shortAssetId: Number(state.core.short_asset_id),
    v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading, v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps,
    v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
    v2AdminControlAppId: PEX_APPS.adminControl,
  } as never, sp) as algosdk.Transaction[];

  const r = assertOpenGroup(txns, {
    storagePaymentMicro: BigInt(0),
    sender: USER, marketId: 1, side: 1,
    collateralAssetId, collateralAmountMicro: collateralMicro,
    sizeUsdDeltaMicro: BigInt(18_000_000),
    acceptablePrice12: acceptable,
    executionPrice12: quote.executionPrice12,
    indexPrice12: oracle.indexPrice12,
    asRenderedLeverage: quote.leverage,
    poolAssets: [Number(state.core.long_asset_id), Number(state.core.short_asset_id)],
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    oracleMessage: oracle.message, oracleSignature: oracle.signature,
  }, openShapeFor(collateralAssetId, false));
  return { r, quote, txns };
}

describe("an ALGO-collateral open passes the real assertion", () => {
  it("USDC still passes, unchanged", async () => {
    const { r, quote } = await openFor(PEX_ASSETS.usdc, BigInt(6_000_000));
    console.log("LINE USDC lev=" + quote.leverage.toFixed(4),
      "ok=" + r.ok, "findings=" + JSON.stringify(r.findings.map((f) => f.code)));
    expect(r.findings.map((f) => f.code)).not.toContain("foreign_asset");
    expect(r.findings.map((f) => f.code)).not.toContain("leverage");
  });

  it("ALGO passes too: no foreign_asset, no leverage, no refusal", async () => {
    // ~200 ALGO, so the USD collateral is near the USDC case above.
    const { r, quote } = await openFor(PEX_ASSETS.algo, BigInt(200_000_000));
    console.log("LINE ALGO lev=" + quote.leverage.toFixed(4),
      "ok=" + r.ok, "findings=" + JSON.stringify(r.findings.map((f) => f.code)));
    const codes = r.findings.map((f) => f.code);
    expect(codes).not.toContain("collateral_asset_unsupported");
    expect(codes).not.toContain("foreign_asset");
    expect(codes).not.toContain("leverage");
    expect(codes).not.toContain("leverage_unpriceable");
  });
});
