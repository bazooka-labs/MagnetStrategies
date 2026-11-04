/**
 * Capture a real market snapshot so the ORDER CARD can be driven hermetically.
 *
 * Run with: CAPTURE=1 npx vitest run --config vitest.live.config.ts \
 *   src/lib/strategy/__fixtures__/captureMarket.live.test.ts
 *
 * Why: the card's quote and ceiling are computed in `useMemo`s that swallow
 * exceptions, so a missing argument shows up as "no size clears the exchange's
 * checks" rather than as an error. Nothing hermetic could reproduce that
 * without a realistic `MarketState` + oracle, and there was no fixture — which
 * is how an ALGO-unusable card reached a user.
 *
 * BigInts are tagged rather than stringified bare, so reviving cannot confuse
 * a numeric string field for a number.
 */
import { describe, it } from "vitest";
import algosdk from "algosdk";
import { writeFileSync } from "node:fs";
import { readMarketState } from "@/lib/strategy/pex/reads";
import { getOraclePayload } from "@/lib/strategy/pex/oracle";
import { PEX_APPS, ACTIVE_MARKET_ID } from "@/lib/strategy/pex/config";

const tag = (_k: string, v: unknown) =>
  typeof v === "bigint" ? { __big: v.toString() }
    : v instanceof Uint8Array ? { __bytes: Buffer.from(v).toString("base64") }
      : v;

describe("capture", () => {
  it.runIf(process.env.CAPTURE === "1")("writes a market snapshot", async () => {
    const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
    const [state, oracle] = await Promise.all([
      readMarketState(algod, ACTIVE_MARKET_ID),
      getOraclePayload(PEX_APPS.trading, ACTIVE_MARKET_ID),
    ]);
    writeFileSync(
      "src/lib/strategy/__fixtures__/marketSnapshot.json",
      JSON.stringify({ capturedAt: new Date().toISOString(), marketId: ACTIVE_MARKET_ID, state, oracle }, tag, 1),
    );
    console.log("LINE captured market " + ACTIVE_MARKET_ID);
  });
});
