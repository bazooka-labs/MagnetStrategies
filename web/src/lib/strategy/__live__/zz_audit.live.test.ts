import { it } from "vitest";
import algosdk from "algosdk";
import { readMarketState } from "@/lib/strategy/pex/reads";
import { getOraclePayload, assetPrice12 } from "@/lib/strategy/pex/oracle";
import { installProtocolManifest } from "@/lib/strategy/pex/manifest";
import { quoteOpen, priceInput } from "@/lib/strategy/pex/quote";
import { PEX_APPS, BUILDER_ADDRESS } from "@/lib/strategy/pex/config";
const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
it("audit", async () => {
  await installProtocolManifest();
  for (const m of [1, 2]) {
    const state = await readMarketState(algod, m);
    const o = await getOraclePayload(PEX_APPS.trading, m);
    const d = o.decoded;
    console.log("MKT", m, "idx", state.core.index_asset_id, "long", state.core.long_asset_id, "short", state.core.short_asset_id,
      "msg long/short", d.longAssetId, d.shortAssetId,
      "idx", d.indexMinPrice, d.indexMaxPrice, "long", d.longMinPrice, d.longMaxPrice, "short", d.shortMinPrice, d.shortMaxPrice,
      "algo12", assetPrice12(d, 0), "usdc12", assetPrice12(d, 31566704));
    console.log("risk", JSON.stringify(state.risk, (_, v) => typeof v === "bigint" ? v.toString() : v));
    for (const side of ["long"] as const) {
      const algo = assetPrice12(d, 0)!;
      const usdcQ = quoteOpen({ state, oracle: o, side, collateralAmountMicro: BigInt(100_000_000), notionalUsd: 300, builderAddress: BUILDER_ADDRESS, collateralAssetId: 31566704 });
      const algoMicro = (BigInt(100_000_000) * BigInt(1e12)) / algo;
      const algoQ = quoteOpen({ state, oracle: o, side, collateralAmountMicro: algoMicro, notionalUsd: 300, builderAddress: BUILDER_ADDRESS, collateralAssetId: 0, algoPrice12: algo });
      for (const [n, q] of [["usdc", usdcQ], ["algo", algoQ]] as const) {
        console.log(m, n, "ok", q.ok, q.reasons, "lev", q.leverage.toFixed(4), "col", q.collateralUsd, "net", q.netCollateralUsd, "fee", q.openFeeUsd, "bfee", q.builderFeeUsd,
          "liq", Number(q.liquidationPrice12) / 1e12, "idx", Number(q.indexPrice12) / 1e12, "drop", 1 - Number(q.liquidationPrice12) / Number(q.indexPrice12));
        console.log("  raw fee", q.raw.platform_fee_amount, "bfee", q.raw.builder_fee_paid, "col_after", q.raw.position_collateral_after, "gross", q.raw.gross_collateral_transfer);
      }
    }
  }
});
