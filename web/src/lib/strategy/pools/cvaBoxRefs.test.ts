// The `gm2:` allocation references on a from-market C-Vault withdrawal.
//
// The bug: a real user withdrawal died in pre-flight with
// `invalid Box reference 0x676d323a0000000000000002` at pc=7789 — market 2's
// allocation box, declared nowhere in the group.
//
// It was INTRODUCED by the fix for pc=8526. That fix narrowed the mark calls
// to the funded markets, which the contract requires; the SDK's from-market
// withdrawal builder then dropped the allocation boxes entirely, because it
// adds them only when there are no marks and assumes the marks carry them.
// Each mark carries only its own market's box.
//
// Measured against MainNet, same wallet and share amount:
//   marks=[1]          -> pc 7789   marks=[1,2] -> pc 8526
//   marks=[]           -> pc 8234   marks=[1] + gm2:2 -> OK
// So the two lists must diverge, and no SDK input expresses that.

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { declareActiveAllocationBoxes, gm2BoxName } from "@/lib/strategy/pools/cvaGroup";

const SENDER = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";
const sp = {
  fee: BigInt(1000), minFee: BigInt(1000), flatFee: true,
  firstValid: BigInt(1), lastValid: BigInt(1001),
  genesisHash: new Uint8Array(32), genesisID: "mainnet-v1.0",
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** `mf2:` is also 12 bytes, so a gm2 filter must check the PREFIX. */
const isGm2Hex = (h: string) => h.startsWith("676d323a") && h.length === 24;

/** An appl txn with the given box slots. */
const call = (boxes: { appIndex: bigint; name: Uint8Array }[], appIndex = 3690309167) =>
  algosdk.makeApplicationNoOpTxnFromObject({
    sender: SENDER, appIndex, suggestedParams: sp as never,
    appArgs: [new Uint8Array([1])], boxes,
    // algosdk refuses a box reference to an app the txn does not name.
    foreignApps: [...new Set(boxes.map((b) => Number(b.appIndex)).filter((n) => n !== 0))],
  });

const empty = (n: number) =>
  Array.from({ length: n }, () => ({ appIndex: BigInt(0), name: new Uint8Array(0) }));

/**
 * The REAL shape, captured from a live 13-txn group.
 *
 * The call the patch targets is `mark_market`, not `withdraw_from_market` —
 * the mark declares `[gm2:<id>, [marketsApp, mf2:<id>]]` so it is the first to
 * carry an allocation box, and references are pooled across the group.
 *
 * The `mf2:` entry matters to this fixture: it is a NON-EMPTY reference
 * sitting between the gm2 and the padding. An earlier fixture had only
 * `gm2:1` plus empties, and a mutation that overwrote the first non-gm2 slot
 * — which in the real group destroys `mf2:1` — passed every test. Review
 * found that. This shape kills it.
 */
const MF2_1 = new Uint8Array(Buffer.concat([
  Buffer.from("mf2:"), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(1)); return b; })(),
]));
const group = () => algosdk.assignGroupID([
  call([{ appIndex: BigInt(3690309159), name: Buffer.from("m2:xx") as unknown as Uint8Array }], 3690309158),
  // mark_market for market 1, on the vault app.
  call([
    { appIndex: BigInt(0), name: gm2BoxName(1) },
    { appIndex: BigInt(3690309159), name: MF2_1 },
    ...empty(4),
  ]),
  // withdraw_from_market itself, carrying the user box and no allocation.
  call([{ appIndex: BigInt(0), name: Buffer.from("gu2:x") as unknown as Uint8Array }, ...empty(4)]),
]);

describe("every active market gets an allocation reference", () => {
  it("adds the missing one", () => {
    const out = declareActiveAllocationBoxes(group(), [1, 2]);
    const names = (out[1].applicationCall?.boxes ?? []).map((b) => hex(b.name));
    expect(names).toContain(hex(gm2BoxName(1)));
    expect(names).toContain(hex(gm2BoxName(2)));
  });

  it("does not duplicate one already declared", () => {
    const out = declareActiveAllocationBoxes(group(), [1]);
    const gm2s = (out[1].applicationCall?.boxes ?? [])
      .map((b) => hex(b.name)).filter(isGm2Hex);
    expect(gm2s).toEqual([hex(gm2BoxName(1))]);
  });

  it("re-groups, because the bytes changed", () => {
    const before = group();
    const idBefore = Buffer.from(before[0].group!).toString("hex");
    const out = declareActiveAllocationBoxes(before, [1, 2]);
    expect(Buffer.from(out[0].group!).toString("hex")).not.toBe(idBefore);
    // and every member must share the new id, or the group is incomplete
    const ids = new Set(out.map((t) => Buffer.from(t.group!).toString("hex")));
    expect(ids.size).toBe(1);
  });

  it("leaves the group untouched when nothing is missing", () => {
    const before = group();
    const idBefore = Buffer.from(before[0].group!).toString("hex");
    const out = declareActiveAllocationBoxes(before, [1]);
    expect(Buffer.from(out[0].group!).toString("hex")).toBe(idBefore);
  });
});

describe("it finds the right call without trusting position", () => {
  it("locates by box CONTENT, so a reordered group still works", () => {
    // Group length varies with recall carriers (11, 13 and 15 all observed),
    // and an absolute index is the defect that caused pc=8526.
    const g = algosdk.assignGroupID([
      call([]),
      call([]),
      call([{ appIndex: BigInt(0), name: gm2BoxName(1) }, ...empty(4)]),
    ]);
    const out = declareActiveAllocationBoxes(g, [1, 2]);
    const names = (out[2].applicationCall?.boxes ?? []).map((b) => hex(b.name));
    expect(names).toContain(hex(gm2BoxName(2)));
    // and it must not have written into the other calls
    expect(out[0].applicationCall?.boxes ?? []).toHaveLength(0);
  });

  it("throws when no call carries an allocation box", () => {
    expect(() => declareActiveAllocationBoxes(
      algosdk.assignGroupID([call([]), call([])]), [1, 2],
    )).toThrow(/declares no allocation box/i);
  });
});

describe("it refuses rather than silently dropping a reference", () => {
  it("throws when the slots are full", () => {
    const g = algosdk.assignGroupID([
      call([{ appIndex: BigInt(0), name: gm2BoxName(1) }]),  // no padding
    ]);
    expect(() => declareActiveAllocationBoxes(g, [1, 2]))
      .toThrow(/no room to declare the allocation box for market 2/i);
  });
});

describe("it changes nothing except box references", () => {
  it("leaves args, receiver, fee and app id alone", () => {
    const before = group();
    const snapshot = before.map((t) => ({
      app: t.applicationCall?.appIndex, fee: t.fee,
      args: (t.applicationCall?.appArgs ?? []).map(hex),
    }));
    const out = declareActiveAllocationBoxes(before, [1, 2]);
    expect(out.map((t) => ({
      app: t.applicationCall?.appIndex, fee: t.fee,
      args: (t.applicationCall?.appArgs ?? []).map(hex),
    }))).toEqual(snapshot);
  });
});

describe("gm2BoxName", () => {
  it("is the prefix plus a big-endian market id", () => {
    expect(hex(gm2BoxName(2))).toBe("676d323a" + "0000000000000002");
    // The exact bytes from the production failure.
    expect(hex(gm2BoxName(2))).toBe("676d323a0000000000000002");
    expect(hex(gm2BoxName(1))).toBe("676d323a0000000000000001");
  });
});

describe("it preserves every reference the group already had", () => {
  it("never overwrites a non-empty slot", () => {
    /**
     * The mutation that survived the first version of this file: writing into
     * the first NON-GM2 slot rather than the first EMPTY one. In the real
     * group that slot holds `mf2:1`, the market's funding/borrowing box, and
     * destroying it would break the mark the withdrawal depends on.
     */
    const before = group();
    const originals = (before[1].applicationCall?.boxes ?? [])
      .map((b, idx) => ({ idx, appIndex: b.appIndex, name: hex(b.name) }))
      .filter((b) => b.name.length > 0);
    const out = declareActiveAllocationBoxes(before, [1, 2]);
    const after = out[1].applicationCall!.boxes!;
    for (const o of originals) {
      expect(after[o.idx].appIndex, `slot ${o.idx} appIndex changed`).toBe(o.appIndex);
      expect(hex(after[o.idx].name), `slot ${o.idx} name changed`).toBe(o.name);
    }
    // and mf2 specifically is still there, wherever it sits
    expect(after.map((b) => hex(b.name))).toContain(hex(MF2_1));
  });

  it("counts references the WHOLE GROUP declares, not just the one call", () => {
    /**
     * When a second market is funded it gets its own mark call carrying its
     * own `gm2:`. A per-call view would add a duplicate here, burn a padding
     * slot, and eventually throw "no room" for something already declared.
     */
    const g = algosdk.assignGroupID([
      call([{ appIndex: BigInt(0), name: gm2BoxName(1) }, ...empty(1)]),
      call([{ appIndex: BigInt(0), name: gm2BoxName(2) }, ...empty(1)]),
    ]);
    const out = declareActiveAllocationBoxes(g, [1, 2]);
    const all = out.flatMap((t) => (t.applicationCall?.boxes ?? [])
      .map((b) => hex(b.name)).filter(isGm2Hex));
    expect(all.sort()).toEqual([hex(gm2BoxName(1)), hex(gm2BoxName(2))].sort());
  });
});

describe("it only claims a gm2 the VAULT declared on itself", () => {
  it("ignores a gm2-shaped name belonging to another app", () => {
    // A carrier declaring a 12-byte gm2-looking box at a non-zero appIndex is
    // not ours, and writing appIndex 0 onto that transaction would point the
    // reference at the wrong app entirely.
    const g = algosdk.assignGroupID([
      call([{ appIndex: BigInt(3690309159), name: gm2BoxName(1) }, ...empty(3)], 3690309158),
      call([{ appIndex: BigInt(0), name: gm2BoxName(1) }, ...empty(3)]),
    ]);
    const out = declareActiveAllocationBoxes(g, [1, 2]);
    // the decoy call is untouched
    expect((out[0].applicationCall!.boxes ?? []).filter((b) => b.name.length > 0)).toHaveLength(1);
    // the real one gained gm2:2
    expect((out[1].applicationCall!.boxes ?? []).map((b) => hex(b.name)))
      .toContain(hex(gm2BoxName(2)));
  });
});
