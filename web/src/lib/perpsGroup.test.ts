// Perps — group assertion tests.
//
// These live in the repo and run under `npm test` deliberately. An earlier set
// lived in a scratch directory, which is the same mistake in a different shape
// as the one the audit found: a test you cannot re-run is not a regression test.
//
// ── What these are for ───────────────────────────────────────────────────────
// Each case takes a group the assertion accepts, breaks ONE thing in a way that
// costs the user money, and requires that the assertion names it. A finding of
// "some error was raised" is not enough — the test asserts the specific code, so
// a check that fires for the wrong reason fails here.
//
// The groups are built by hand rather than by the SDK so these stay offline and
// deterministic. The shapes were captured from real MainNet groups; the
// end-to-end check that the real builder still produces this shape belongs in
// the live harness, not here.

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { BUILDER_ADDRESS, PEX_APPS, PEX_ASSETS, POSITION_BUILDER_FEE_BPS } from "./perps";
import {
  CLOSE_SELECTOR,
  ORDER_BOX_MBR_MICRO_ALGO,
  PEX_SELECTORS,
  POSITION_ID_WILDCARD,
  assertCloseGroup,
  assertOpenGroup,
  type DisplayedClose,
  type DisplayedOpen,
} from "./perpsGroup";

const ATTACKER = "7777777777777777777777777777777777777777777777777774MSJUVU";
const USER = BUILDER_ADDRESS || "A".repeat(58);
const TRADING_ADDR = algosdk.getApplicationAddress(PEX_APPS.trading).toString();

const EXEC = BigInt(106_000_000_000);      // execution price, Price12
const INDEX = BigInt(106_500_000_000);
const COLLATERAL = BigInt(25_000_000);     // $25
const SIZE = BigInt(100_000_000);          // $100 notional
const ORACLE_MSG = new Uint8Array(133).fill(7);
const ORACLE_SIG = new Uint8Array(64).fill(9);

const u64 = (v: bigint) => algosdk.encodeUint64(v);
/** ABI dynamic byte[]: 2-byte big-endian length prefix then the bytes. */
const abiBytes = (b: Uint8Array) => {
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 0xff;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
};
const builderTuple = (addr: string, bps: bigint) => {
  const out = new Uint8Array(40);
  out.set(algosdk.decodeAddress(addr).publicKey, 0);
  out.set(u64(bps), 32);
  return out;
};
const sel = (hex: string) =>
  Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

/** Minimal stand-in carrying only the fields the assertion reads. */
type Leg = Record<string, unknown> & { txID: () => string };
let nonce = 0;
const leg = (o: Record<string, unknown>): Leg => {
  const id = `TX${(nonce += 1)}`;
  return { fee: BigInt(1000), sender: USER, ...o, txID: () => id };
};

function openGroup(): Leg[] {
  return [
    leg({
      type: "axfer",
      assetTransfer: {
        assetIndex: BigInt(PEX_ASSETS.usdc), amount: COLLATERAL,
        receiver: TRADING_ADDR,
      },
    }),
    leg({
      type: "appl", fee: BigInt(30_000),
      applicationCall: {
        appIndex: BigInt(PEX_APPS.trading),
        appArgs: [
          sel(PEX_SELECTORS.openOrIncrease),
          u64(BigInt(1)), u64(BigInt(1)), u64(SIZE),
          u64((EXEC * BigInt(10_030)) / BigInt(10_000)),
          builderTuple(USER, BigInt(POSITION_BUILDER_FEE_BPS)),
          abiBytes(ORACLE_MSG), abiBytes(ORACLE_SIG),
        ],
        accounts: [USER],
      },
    }),
    leg({ type: "appl", applicationCall: { appIndex: BigInt(PEX_APPS.math), appArgs: [sel(PEX_SELECTORS.mathNoop)] } }),
  ];
}

const shownOpen = (): DisplayedOpen => ({
  storagePaymentMicro: BigInt(0),
  sender: USER, marketId: 1, side: 1, collateralAssetId: PEX_ASSETS.usdc,
  collateralAmountMicro: COLLATERAL, sizeUsdDeltaMicro: SIZE,
  acceptablePrice12: (EXEC * BigInt(10_030)) / BigInt(10_000),
  executionPrice12: EXEC, indexPrice12: INDEX, slippageBps: 50,
  oracleMessage: ORACLE_MSG, oracleSignature: ORACLE_SIG,
});

describe("assertOpenGroup", () => {
  it("accepts an honest group", () => {
    const r = assertOpenGroup(openGroup(), shownOpen());
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // Each case must be named by its OWN code, not merely rejected.
  type Case = [string, (g: Leg[]) => void, string, ((d: DisplayedOpen) => void)?];
  const cases: Case[] = [
    ["leverage inflated while the transfer is untouched",
      (g) => { (g[1].applicationCall as { appArgs: Uint8Array[] }).appArgs[3] = u64(SIZE * BigInt(5)); },
      "size_usd_delta"],
    ["collateral redirected to an attacker",
      (g) => { (g[0].assetTransfer as { receiver: string }).receiver = ATTACKER; },
      "transfer_receiver"],
    ["collateral asset swapped",
      (g) => { (g[0].assetTransfer as { assetIndex: bigint }).assetIndex = BigInt(1_284_444_444); },
      "transfer_asset"],
    ["builder fee redirected to an attacker",
      (g) => { (g[1].applicationCall as { appArgs: Uint8Array[] }).appArgs[5] = builderTuple(ATTACKER, BigInt(POSITION_BUILDER_FEE_BPS)); },
      "builder_address"],
    ["builder fee raised above the pinned rate",
      (g) => { (g[1].applicationCall as { appArgs: Uint8Array[] }).appArgs[5] = builderTuple(USER, BigInt(100)); },
      "builder_bps"],
    ["rekeyTo set on a leg",
      (g) => { g[0].rekeyTo = ATTACKER; },
      "rekey"],
    ["assetCloseTo set, sweeping the balance",
      (g) => { (g[0].assetTransfer as { closeRemainderTo?: string }).closeRemainderTo = ATTACKER; },
      "asset_close_to"],
    // Both the group AND the screen carry the bad value — a consistent lie, so
    // the equality check passes and only the directional bound can catch it.
    // That is the attack worth testing: a frontend that displays what it sends.
    ["acceptable price on the WRONG side of execution",
      (g) => { (g[1].applicationCall as { appArgs: Uint8Array[] }).appArgs[4] = u64((EXEC * BigInt(9_900)) / BigInt(10_000)); },
      "slippage",
      (d) => { d.acceptablePrice12 = (EXEC * BigInt(9_900)) / BigInt(10_000); }],
    ["acceptable price loosened far past tolerance",
      (g) => { (g[1].applicationCall as { appArgs: Uint8Array[] }).appArgs[4] = u64(EXEC * BigInt(2)); },
      "slippage",
      (d) => { d.acceptablePrice12 = EXEC * BigInt(2); }],
    ["oracle message replaced",
      (g) => { (g[1].applicationCall as { appArgs: Uint8Array[] }).appArgs[6] = abiBytes(new Uint8Array(133).fill(1)); },
      "oracle_message"],
    ["oracle signature replaced",
      (g) => { (g[1].applicationCall as { appArgs: Uint8Array[] }).appArgs[7] = abiBytes(new Uint8Array(64).fill(1)); },
      "oracle_signature"],
    ["a leg sent by someone other than the user",
      (g) => { g[0].sender = ATTACKER; },
      "foreign_sender"],
    ["call to an app this flow never uses",
      (g) => { g.push(leg({ type: "appl", applicationCall: { appIndex: BigInt(PEX_APPS.cvaVault), appArgs: [sel("deadbeef")] } })); },
      "unpinned_app"],
    ["a second Trading call appended",
      (g) => { g.push(leg({ type: "appl", applicationCall: { appIndex: BigInt(PEX_APPS.trading), appArgs: [sel(PEX_SELECTORS.openOrIncrease)] } })); },
      "call_budget"],
    ["fees inflated across the group",
      (g) => { g.forEach((t) => { t.fee = BigInt(60_000); }); },
      "fee_cap"],
    ["duplicate transaction ids",
      (g) => { const id = g[0].txID(); g[2].txID = () => id; },
      "duplicate_txids"],
  ];

  for (const [name, mutate, code, alsoShown] of cases) {
    it(`catches: ${name}`, () => {
      const g = openGroup();
      mutate(g);
      const shown = shownOpen();
      alsoShown?.(shown);
      const r = assertOpenGroup(g, shown);
      expect(r.ok).toBe(false);
      expect(r.findings.map((f) => f.code)).toContain(code);
    });
  }
});

// ── Close path ────────────────────────────────────────────────────────────────

const POS_ID = BigInt(4242);

function closeGroup(): Leg[] {
  return [
    leg({
      type: "appl", fee: BigInt(38_000),
      applicationCall: {
        appIndex: BigInt(PEX_APPS.trading),
        appArgs: [
          sel(CLOSE_SELECTOR),
          u64(BigInt(1)), u64(BigInt(PEX_ASSETS.usdc)), u64(BigInt(1)), u64(SIZE),
          u64((EXEC * BigInt(9_970)) / BigInt(10_000)),
          u64(BigInt(0)), u64(BigInt(0)), u64(BigInt(0)),
          builderTuple(USER, BigInt(POSITION_BUILDER_FEE_BPS)),
          abiBytes(ORACLE_MSG), abiBytes(ORACLE_SIG),
          u64(BigInt(0)), u64(BigInt(0)), u64(BigInt(0)), u64(POS_ID),
        ],
      },
    }),
    leg({ type: "appl", applicationCall: { appIndex: BigInt(PEX_APPS.math), appArgs: [sel(PEX_SELECTORS.mathNoop)] } }),
  ];
}

const shownClose = (): DisplayedClose => ({
  sender: USER, marketId: 1, side: 1, collateralAssetId: PEX_ASSETS.usdc,
  sizeUsdDeltaMicro: SIZE, positionSizeUsdMicro: SIZE, fullClose: true,
  acceptablePrice12: (EXEC * BigInt(9_970)) / BigInt(10_000),
  executionPrice12: EXEC, indexPrice12: INDEX, slippageBps: 50,
  expectedPositionId: POS_ID,
  oracleMessage: ORACLE_MSG, oracleSignature: ORACLE_SIG,
  yieldRecallMode: BigInt(0), maxLongReceiptAmount: BigInt(0), maxShortReceiptAmount: BigInt(0),
});

describe("assertCloseGroup", () => {
  it("accepts an honest close", () => {
    const r = assertCloseGroup(closeGroup(), shownClose());
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  type CloseCase = [string, (g: Leg[]) => void, string, ((d: DisplayedClose) => void)?];
  const cases: CloseCase[] = [
    ["expectedPositionId set to the wildcard, closing whatever occupies the key",
      (g) => { (g[0].applicationCall as { appArgs: Uint8Array[] }).appArgs[15] = u64(POSITION_ID_WILDCARD); },
      "position_id_wildcard"],
    ["a partial close disguised as a full one",
      (g) => { (g[0].applicationCall as { appArgs: Uint8Array[] }).appArgs[4] = u64(SIZE / BigInt(100)); },
      "size_usd_delta"],
    ["bound to a different position",
      (g) => { (g[0].applicationCall as { appArgs: Uint8Array[] }).appArgs[15] = u64(BigInt(99)); },
      "position_id"],
    ["output swap mode enabled",
      (g) => { (g[0].applicationCall as { appArgs: Uint8Array[] }).appArgs[6] = u64(BigInt(1)); },
      "output_swap_mode"],
    ["receipt cap raised above what preparation authorised",
      (g) => { (g[0].applicationCall as { appArgs: Uint8Array[] }).appArgs[13] = u64(BigInt(10) ** BigInt(12)); },
      "max_long_receipt"],
    ["a value transfer smuggled into the close",
      (g) => { g.push(leg({ type: "axfer", assetTransfer: { assetIndex: BigInt(PEX_ASSETS.usdc), amount: BigInt(5_000_000), receiver: ATTACKER } })); },
      "unexpected_transfer"],
    ["close acceptable price on the WRONG side of execution",
      (g) => { (g[0].applicationCall as { appArgs: Uint8Array[] }).appArgs[5] = u64((EXEC * BigInt(10_030)) / BigInt(10_000)); },
      "slippage",
      (d) => { d.acceptablePrice12 = (EXEC * BigInt(10_030)) / BigInt(10_000); }],
  ];

  for (const [name, mutate, code, alsoShown] of cases) {
    it(`catches: ${name}`, () => {
      const g = closeGroup();
      mutate(g);
      const shown = shownClose();
      alsoShown?.(shown);
      const r = assertCloseGroup(g, shown);
      expect(r.ok).toBe(false);
      expect(r.findings.map((f) => f.code)).toContain(code);
    });
  }
});

describe("pinned constants", () => {
  // These are the values the contract enforces. If one drifts, a group either
  // fails on chain or overpays, and neither is visible from a passing typecheck.
  it("order-box MBR is the current value, not the legacy one", () => {
    expect(ORDER_BOX_MBR_MICRO_ALGO).toBe(BigInt(99_700));
  });
  it("the close wildcard is 2^64 - 1", () => {
    expect(POSITION_ID_WILDCARD).toBe((BigInt(1) << BigInt(64)) - BigInt(1));
  });
});
