/**
 * Can a perps CLOSE pay out in a single asset?
 *
 * The terminal passes `outputSwapMode: 0` on every close path, so a close pays
 * out BY ASSET and real ones have paid two — `PositionsPanel` literally renders
 * "Pays out in two assets". PEX ships
 * `buildV2DecreaseOrCloseWithSwapTransactions` and we have never called it.
 *
 * This probes whether it works, on a REAL open position, so the answer is
 * measured rather than assumed. Nothing is signed.
 *
 * ── RESULT, 2026-10-23: PARTIAL. Do not read this as "it works". ──
 * All three output modes are ACCEPTED — 10 transactions, 123,000 µALGO, and the
 * contract emits `v2_position_decreased_with_output_swap`. But the position
 * available to test had:
 *
 *     collateral_output        91,273,763   (USDC)
 *     pnl_output_before_swap   0
 *     swap_token_out           0
 *
 * i.e. nothing to convert. So what is proven is that the CALL SHAPE is valid;
 * whether the swap actually converts a second asset is NOT proven, because no
 * second asset was present.
 *
 * The two-asset close this would solve comes from `claimable_long_token_output`
 * / `claimable_short_token_output` (see `aggregateCloseOutputs`), not from
 * `pnl_output` — a real close has paid "16.251005 ALGO + 5.568338 USDC".
 * Confirming this needs a position holding a non-zero claimable token output,
 * which cannot be manufactured on demand.
 *
 * Until then the terminal keeps `outputSwapMode: 0` and keeps saying "Pays out
 * in two assets", which is true.
 */
import { describe, it } from "vitest";
import algosdk from "algosdk";
import {
  buildV2DecreaseOrCloseWithSwapTransactions, decodeReceipt,
} from "@pdex/sdk";
import { simulateGroup } from "@/lib/strategy/pex/group";
import { readMarketState, readPosition, readYieldRegistry } from "@/lib/strategy/pex/reads";
import { getOraclePayload } from "@/lib/strategy/pex/oracle";
import { installProtocolManifest } from "@/lib/strategy/pex/manifest";
import {
  PEX_APPS, PEX_ASSETS, COLLATERAL_ASSET_ID, BUILDER_ADDRESS,
  POSITION_BUILDER_FEE_BPS,
} from "@/lib/strategy/pex/config";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
/** A real market-1 LONG, from the live `p2:` box listing. */
const TRADER = "6UE6PHOA6234L5HTVRMJGN7TKLGCTVLLFTI5DMWUUHJ6OZFGPXFE7QQENU";

describe("probe: single-asset position close", () => {
  it("tries each output mode against a real position", async () => {
    await installProtocolManifest();
    const marketId = 1;
    const pos = await readPosition(algod, TRADER, marketId, COLLATERAL_ASSET_ID, 1);
    if (!pos) { console.log("no live position for this trader any more; skipping"); return; }
    console.log(`position: size_usd ${pos.size_usd}, id ${pos.position_id}`);

    const state = await readMarketState(algod, marketId);
    const oracle = await getOraclePayload(PEX_APPS.trading, marketId);
    const registry = await readYieldRegistry(
      algod, marketId, COLLATERAL_ASSET_ID, Number(state.core.index_asset_id));
    const sp = await algod.getTransactionParams().do();
    sp.fee = sp.minFee; sp.flatFee = true;
    const BIG = BigInt(2_000_000_000);

    for (const [label, mode] of [
      ["mode 0 (both, as shipped)", 0],
      ["mode 1", 1],
      ["mode 2", 2],
    ] as const) {
      try {
        const g = buildV2DecreaseOrCloseWithSwapTransactions({
          sender: TRADER, marketId,
          collateralAssetId: COLLATERAL_ASSET_ID,
          side: BigInt(1),
          sizeUsdDelta: pos.size_usd,
          // A long close SELLS, so it accepts a price below index. 10% of
          // slack: this probe is about whether the shape is accepted, not
          // about price discipline.
          acceptablePrice: oracle.indexPrice12 * BigInt(90) / BigInt(100),
          outputSwapMode: mode,
          minPrimaryOutputAmount: 0, minSecondaryOutputAmount: 0,
          builderFee: {
            builderAddress: BUILDER_ADDRESS,
            builderFeeBps: BigInt(POSITION_BUILDER_FEE_BPS),
          },
          oracleMessage: oracle.message, oracleSignature: oracle.signature,
          yieldRecallMode: 1,
          maxLongReceiptAmount: BIG, maxShortReceiptAmount: BIG,
          marketYieldRegistry: registry,
          expectedPositionId: pos.position_id,
          indexAssetId: Number(state.core.index_asset_id),
          longAssetId: Number(state.core.long_asset_id),
          shortAssetId: Number(state.core.short_asset_id),
          v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
          v2TradingAppId: PEX_APPS.trading,
          v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
          v2OrderOpsAppId: PEX_APPS.orderOps, v2SwapOpsAppId: PEX_APPS.swapOps,
          v2AdminControlAppId: PEX_APPS.adminControl,
          v2MarketYieldVaultAppId: PEX_APPS.marketYieldVault,
          v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
        } as never, sp) as algosdk.Transaction[];
        const r = await simulateGroup(algod, g);
        if (!r.ok) {
          console.log(`${label}: REJECTED (${g.length} txns) ${String(r.message).slice(0, 130)}`);
          continue;
        }
        const out: string[] = [];
        for (const log of r.logs ?? []) {
          if (Buffer.from(log.slice(0, 4)).toString("hex") !== "151f7c75") continue;
          const b = log.slice(4); const len = (b[0] << 8) | b[1];
          try {
            const rec = decodeReceipt(b.slice(2, 2 + len)) as unknown as
              { eventType?: string; fields?: Record<string, unknown> };
            const f = Object.entries(rec.fields ?? {})
              .filter(([k]) => /output|out|swap|asset/.test(k))
              .map(([k, v]) => `${k}=${v}`).join(" ");
            if (f) out.push(`${rec.eventType}{${f}}`);
          } catch { /* not a receipt */ }
        }
        console.log(`${label}: OK ${g.length} txns, `
          + `${g.reduce((a, t) => a + Number(t.fee), 0)} µALGO`);
        for (const o of out) console.log(`      ${o}`);
      } catch (e) {
        console.log(`${label}: THREW ${(e as Error).message.slice(0, 130)}`);
      }
    }
    void PEX_ASSETS;
  }, 240_000);
});
