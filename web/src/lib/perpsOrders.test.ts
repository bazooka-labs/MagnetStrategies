// Perps — the `o2:` order box layout.
//
// Fixtures are the REAL field values of two orders live on MainNet on
// 2026-09-28: our own attached take-profit, and another trader's standalone
// limit entry. Pinned because the layout is the protocol manifest's CLAIM about
// PEX, and a silent field reorder upstream would mislabel a stop-loss as a
// take-profit — or shift every field after `builder_address`, which is the
// exact way the p2: decoder was once wrong on two live positions.
//
// Network-free: these are recorded bytes, not live state.

import { describe, expect, it } from "vitest";

import { decodeOrder, ORDER_BOX_BYTES, ORDER_KIND } from "./perpsReads";

/** Build a 200-byte order box from field values, at the declared offsets. */
const box = (u64s: Record<number, bigint>, builder?: Uint8Array): Uint8Array => {
  const raw = new Uint8Array(ORDER_BOX_BYTES);
  const view = new DataView(raw.buffer);
  for (const [slot, v] of Object.entries(u64s)) view.setBigUint64(Number(slot) * 8, v, false);
  if (builder) raw.set(builder, 152);
  return raw;
};
const OWNER = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

describe("decodeOrder — the o2: layout", () => {
  it("decodes our own live take-profit exactly", () => {
    // Measured on chain: id 2, bound to position 75, $88.479362 of size,
    // trigger $0.14, acceptable $0.1393, 10 bps, $0.10 keeper fee.
    const o = decodeOrder(box({
      0: BigInt(4), 1: BigInt(2), 2: BigInt(1), 3: BigInt(1), 4: BigInt(2), 5: BigInt(1),
      6: BigInt(31566704), 7: BigInt(88_479_362), 8: BigInt(0),
      9: BigInt(140_000_000_000), 10: BigInt(139_300_000_000),
      11: BigInt(31566704), 12: BigInt(100_000), 17: BigInt(1_790_625_586),
      23: BigInt(10), 24: BigInt(75),
    }), OWNER);
    expect(o.order_kind).toBe(BigInt(ORDER_KIND.takeProfit));
    expect(o.owner_order_id).toBe(BigInt(2));
    expect(o.side).toBe(BigInt(1));
    expect(o.size_usd_delta).toBe(BigInt(88_479_362));
    expect(o.trigger_price).toBe(BigInt(140_000_000_000));
    expect(o.acceptable_price).toBe(BigInt(139_300_000_000));
    expect(o.keeper_fee_amount).toBe(BigInt(100_000));
    expect(o.builder_fee_bps).toBe(BigInt(10));
    // The field that binds it to a position. A reduce order with position_id 0
    // is not yet armed; ours is 75, matching the p2: box.
    expect(o.position_id).toBe(BigInt(75));
    expect(o.owner).toBe(OWNER);
  });

  it("decodes a standalone limit entry, which escrows collateral", () => {
    // The distinguishing field: OPEN_LIMIT carries the stake, a reduce order
    // reports 0 because it draws from the position it closes.
    const o = decodeOrder(box({
      0: BigInt(4), 1: BigInt(1), 3: BigInt(1), 5: BigInt(2),
      6: BigInt(31566704), 7: BigInt(90_000_000), 8: BigInt(10_081_759),
      9: BigInt(140_000_000_000), 10: BigInt(138_600_000_000), 12: BigInt(51_000),
      23: BigInt(3), 24: BigInt(0),
    }), OWNER);
    expect(o.order_kind).toBe(BigInt(ORDER_KIND.openLimit));
    expect(o.collateral_amount).toBe(BigInt(10_081_759));
    expect(o.position_id).toBe(BigInt(0));
    expect(o.side).toBe(BigInt(2));
  });

  it("reads builder_address as 32 bytes, not 8", () => {
    // It sits between `flags` and `builder_fee_bps`. Treating it as a uint64
    // would shift every field after it — which is how the p2: decoder was once
    // wrong, silently, on two live positions.
    const pk = new Uint8Array(32).fill(7);
    const o = decodeOrder(box({ 0: BigInt(4), 1: BigInt(1), 23: BigInt(10), 24: BigInt(75) }, pk), OWNER);
    expect(o.builder_fee_bps).toBe(BigInt(10));
    expect(o.position_id).toBe(BigInt(75));
    expect(o.builder_address).toHaveLength(58);
  });

  it("refuses a box of the wrong size rather than decoding garbage", () => {
    expect(() => decodeOrder(new Uint8Array(199), OWNER)).toThrow(/199 bytes/);
    expect(() => decodeOrder(new Uint8Array(208), OWNER)).toThrow(/208 bytes/);
  });
});
