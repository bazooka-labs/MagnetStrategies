/**
 * What the close checks about the WALLET before it builds anything.
 *
 * The close path read no account state at all. Two audit findings followed:
 *
 *   - A close pays out in the market's assets, not only the collateral. A
 *     profitable ALGO-collateral SHORT on ALGO/USD is paid its profit in USDC
 *     — the real close on 2026-11-05 moved 12.259258 USDC to the owner. An ASA
 *     transfer to a wallet that is not opted in fails, and the group is
 *     atomic, so such a holder had no exit and a raw `logic eval error` to go
 *     on.
 *   - No ALGO balance check, so an empty wallet got an algod struct dump
 *     ("tried to spend 38mA") instead of a sentence.
 *
 * Neither is a fund-safety hole — nothing is signed either way. Both are the
 * difference between a user who knows what to do and one who thinks their
 * collateral is gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const readPosition = vi.fn();
const readMarketState = vi.fn();
vi.mock("@/lib/strategy/pex/reads", () => ({
  readPosition: (...a: unknown[]) => readPosition(...a),
  readMarketState: (...a: unknown[]) => readMarketState(...a),
  readMarketFunding: vi.fn(),
  readYieldRegistry: vi.fn(),
}));
vi.mock("@/lib/strategy/pex/manifest", () => ({ installProtocolManifest: vi.fn() }));
vi.mock("@/lib/strategy/perps/preflight", () => ({
  preflight: async () => ({ kind: "ok", canOpen: true }),
  exitBlocked: () => false,
  EXIT_BLOCKS: [],
}));

import { closePosition } from "./client";
import { PEX_ASSETS } from "@/lib/strategy/pex/config";

const SENDER = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

/** ALGO/USD: long leg ALGO, short leg USDC — the shape that pays USDC profit. */
const MARKET = {
  core: {
    long_asset_id: BigInt(PEX_ASSETS.algo),
    short_asset_id: BigInt(PEX_ASSETS.usdc),
    index_asset_id: BigInt(PEX_ASSETS.algo),
  },
};

const algodWith = (opts: { assets?: number[]; microAlgo?: number }) => ({
  accountInformation: () => ({
    do: async () => ({
      amount: opts.microAlgo ?? 5_000_000,
      assets: (opts.assets ?? []).map((assetId) => ({ assetId, amount: 0 })),
    }),
  }),
}) as never;

const close = (algod: never) => closePosition({
  algod,
  signTransactions: async () => [],
  sender: SENDER,
  marketId: 1,
  side: "short",
  collateralAssetId: PEX_ASSETS.algo,
  sizeUsdMicro: BigInt(193_029_136),
  position: {} as never,
  quote: { ok: true, executionPrice12: BigInt(93_000_000_000) } as never,
});

beforeEach(() => {
  readPosition.mockReset();
  readMarketState.mockReset();
  readMarketState.mockResolvedValue(MARKET);
  // Never reached in these tests: every case refuses before the box re-read.
  readPosition.mockResolvedValue(null);
});

describe("the wallet must be able to receive the payout", () => {
  it("refuses, by name, when not opted in to the payout asset", async () => {
    // The trap: ALGO collateral, profit paid in USDC, no USDC opt-in.
    await expect(close(algodWith({ assets: [] })))
      .rejects.toThrow(/not opted in/i);
  });

  it("names the asset and says the collateral is safe", async () => {
    // "Your funds are gone" is what a raw logic-eval error implies. This is
    // the sentence that has to replace it.
    await expect(close(algodWith({ assets: [] })))
      .rejects.toThrow(/USDC[\s\S]*collateral stays safe/i);
  });

  it("proceeds once the opt-in exists", async () => {
    // Past the preflight, so it fails later on the stubbed position read —
    // which is what proves the preflight is not what refused it.
    await expect(close(algodWith({ assets: [PEX_ASSETS.usdc] })))
      .rejects.not.toThrow(/not opted in/i);
  });

  it("never demands an opt-in for ALGO, which is not an ASA", async () => {
    // ALGO is the long leg here. Requiring an "opt-in" for it would block
    // every close on this market.
    await expect(close(algodWith({ assets: [PEX_ASSETS.usdc] })))
      .rejects.not.toThrow(/ALGO.*not opted in/i);
  });
});

describe("the wallet must afford the network fees", () => {
  it("refuses with figures rather than an algod struct dump", async () => {
    await expect(close(algodWith({ assets: [PEX_ASSETS.usdc], microAlgo: 0 })))
      .rejects.toThrow(/ALGO in this wallet for network fees/i);
  });

  it("says nothing was sent", async () => {
    await expect(close(algodWith({ assets: [PEX_ASSETS.usdc], microAlgo: 1000 })))
      .rejects.toThrow(/nothing was sent/i);
  });

  it("lets a funded wallet through", async () => {
    await expect(close(algodWith({ assets: [PEX_ASSETS.usdc], microAlgo: 5_000_000 })))
      .rejects.not.toThrow(/network fees/i);
  });
});
