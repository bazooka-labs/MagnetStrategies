// Perps — the exit gate, the exit banner, and the order-id allocation rule.
//
// All three are audit 9 fixes, and all three are the same shape of defect: a
// rule that looked right, had a comment asserting it was right, and was not.
//
// ── Why these are worth tests at all ───────────────────────────────────────
// Neither failure is visible. A close button disabled when it should be enabled
// looks like the exchange being down; one ENABLED when it should be disabled
// looks fine until it dies in simulation. An order id landing inside a live
// bracket's reserved stride looks like nothing until a cancel touches the wrong
// box. No build, type-check or click-through surfaces any of it, which is how
// they survived two audits.

import { describe, expect, it } from "vitest";
import {
  EXIT_BLOCKS,
  exitBanner,
  exitBlocked,
  type PreflightKind,
} from "./perpsPreflight";
import {
  nextBaseOrderId,
  ORDER_ID_STRIDE,
  ORDER_LINK_MODE_FACTOR,
  orderLinkBaseOrderId,
} from "./perpsReads";
import type { OrderState } from "./perpsReads";

describe("exit gate", () => {
  const allKinds = Object.keys(EXIT_BLOCKS) as PreflightKind[];

  it("covers every refusal kind", () => {
    // The Record enforces totality at compile time. This pins the set at
    // runtime so that adding a kind FAILS here and has to be classified
    // deliberately — it is not picked up automatically, and saying so matters:
    // the previous version of this comment claimed it was.
    expect([...allKinds].sort()).toEqual(
      ["builder_balance", "builder_optin", "drift", "layout", "ok", "unreachable"].sort(),
    );
  });

  it("blocks exits on drift, unreachable, and a missing builder opt-in", () => {
    expect([...allKinds].filter(exitBlocked).sort()).toEqual(
      ["builder_optin", "drift", "unreachable"].sort(),
    );
  });

  it("blocks an exit when the builder is NOT opted in", () => {
    // Review of audit 9 found this excluded, on the stated grounds that a close
    // pays no builder fee. It does: `closePosition` passes a builderFee and
    // `assertCloseGroup` requires the close leg's builder tuple to match. With
    // no opt-in the close's fee transfer fails at the chain, so offering the
    // button only moves the failure to after the click.
    expect(exitBlocked("builder_optin")).toBe(true);
  });

  it("does NOT block an exit on the builder's ALGO balance", () => {
    // Receiving an ASA costs the receiver nothing, so a close is unaffected.
    // Trapping a user in a leveraged position over our treasury's ALGO balance
    // is the self-inflicted trap the narrow gate exists to prevent.
    expect(exitBlocked("builder_balance")).toBe(false);
  });

  it("does NOT block an exit on the leverage ceiling", () => {
    expect(exitBlocked("layout")).toBe(false);
  });

  it("does not block an exit when nothing is wrong", () => {
    expect(exitBlocked("ok")).toBe(false);
  });

  it("blocks an unknown refusal rather than letting it through", () => {
    // The Record is total at compile time only. A value from outside the type —
    // a cached result from an older build — must not index to undefined and
    // read as "does not block".
    expect(exitBlocked("something-from-an-older-build" as PreflightKind)).toBe(true);
  });
});

describe("exit banner", () => {
  it("treats a pending check as 'not yet', never as permission", () => {
    // Introduced twice already. If this ever returns null while the first
    // check is in flight, the panel offers Close and the client then throws.
    expect(exitBanner(null, null, null)).not.toBeNull();
    expect(exitBanner(null, null, "anything")).toContain("Checking");
  });

  it("allows exits when the refusal cannot affect them", () => {
    expect(exitBanner(false, "builder_balance", "Trading is unavailable.")).toBeNull();
    expect(exitBanner(false, "layout", "Trading is unavailable.")).toBeNull();
  });

  it("blocks exits when the refusal does affect them", () => {
    expect(exitBanner(false, "drift", "PEX was upgraded.")).toBe("PEX was upgraded.");
    expect(exitBanner(false, "unreachable", "Could not verify.")).toBe("Could not verify.");
    expect(exitBanner(false, "builder_optin", "Config problem.")).toBe("Config problem.");
  });

  it("allows exits when the preflight is happy", () => {
    expect(exitBanner(true, "ok", null)).toBeNull();
  });

  it("never returns an empty banner when it blocks", () => {
    // A blocked exit with no reason would disable the button and explain
    // nothing, which is the failure mode the panel was built to end.
    expect(exitBanner(false, "drift", null)).toBeTruthy();
  });

  it("would catch a revert to the open-gate rule", () => {
    // The specific regression: gating on `canOpen !== true` blocks exits for
    // every refusal, including the two that cannot affect them.
    const openGate = (canOpen: boolean | null) => (canOpen !== true ? "blocked" : null);
    expect(openGate(false)).not.toBeNull();
    expect(exitBanner(false, "builder_balance", "x")).toBeNull();
  });
});

describe("order id allocation", () => {
  const S = Number(ORDER_ID_STRIDE);
  const strideOf = (base: bigint) => [base, base + BigInt(1), base + BigInt(2)];

  it("starts above zero on a fresh account", () => {
    expect(nextBaseOrderId([])).toBe(ORDER_ID_STRIDE);
    expect(nextBaseOrderId([]) > BigInt(0)).toBe(true);
  });

  it("clears the stride of a CHILDLESS bracket parent", () => {
    // The case that motivated the fix. A bare limit order takes base 1 and
    // reserves {1,2,3} but creates box 1 alone, so `listOrderIds` reports [1].
    // The old rule returned 2 — order 1's take-profit slot.
    expect(nextBaseOrderId([BigInt(1)])).toBe(BigInt(4));
    expect(nextBaseOrderId([BigInt(1)])).not.toBe(BigInt(2));
  });

  it("clears the stride of a fully occupied bracket", () => {
    expect(nextBaseOrderId([BigInt(1), BigInt(2), BigInt(3)])).toBe(BigInt(6));
  });

  it("never reserves a slot any EXISTING order could have reserved", () => {
    // THE property — and the previous version of this test did not test it.
    //
    // It asserted only that the new stride misses `existing`. Under the old
    // `highest + 1` rule the new stride is {H+1, H+2, H+3} and every existing
    // id is <= H, so that assertion passed with the bug in place: a test that
    // tested around the defect, which is the exact failure this codebase
    // already names for the audit-8 tamper table.
    //
    // What matters is the RESERVATION, not the box: an order at K reserves
    // {K, K+1, K+2} whether or not it ever creates them.
    const shapes: bigint[][] = [
      [],
      [BigInt(1)],
      [BigInt(3)],
      [BigInt(1), BigInt(2), BigInt(3)],
      [BigInt(7), BigInt(1), BigInt(4)],
      [BigInt(433)],
      [BigInt(1), BigInt(433), BigInt(12)],
    ];
    for (const existing of shapes) {
      const mine = new Set(strideOf(nextBaseOrderId(existing)).map(String));
      for (const k of existing) {
        for (const theirs of strideOf(k)) {
          expect(
            mine.has(String(theirs)),
            `order ${k} reserves ${theirs}, which the new stride also claims`,
          ).toBe(false);
        }
      }
    }
  });

  it("steps by exactly the stride", () => {
    // Pinned so a change to ORDER_ID_STRIDE moves the allocator with it rather
    // than leaving a hard-coded 3 behind.
    expect(nextBaseOrderId([BigInt(10)])).toBe(BigInt(10 + S));
  });
});

describe("order link base", () => {
  // The guard that protects accounts whose ids were allocated under the old
  // `highest + 1` rule: a box sitting in a bracket's reserved slot is only that
  // bracket's child if its packed link says so.
  const withFlags = (flags: bigint) => ({ flags } as unknown as OrderState);
  const LINKED = (mode: number, base: bigint) =>
    withFlags(BigInt(mode) * ORDER_LINK_MODE_FACTOR + base);

  it("reads the parent id out of the packed flags word", () => {
    // Mirrors v2OrderLinkBase: flags % 2^61, with the mode in the high bits.
    expect(orderLinkBaseOrderId(LINKED(2, BigInt(7)))).toBe(BigInt(7));
    expect(orderLinkBaseOrderId(LINKED(3, BigInt(433)))).toBe(BigInt(433));
  });

  it("reports no parent for a standalone order", () => {
    expect(orderLinkBaseOrderId(withFlags(BigInt(0)))).toBe(BigInt(0));
  });

  it("distinguishes a real child from a squatter in the same slot", () => {
    // Order 1 is a bracket parent; slot 2 is its reserved take-profit.
    const realChild = LINKED(2, BigInt(1));
    const legacySquatter = withFlags(BigInt(0)); // an independent entry at id 2
    expect(orderLinkBaseOrderId(realChild)).toBe(BigInt(1));
    expect(orderLinkBaseOrderId(legacySquatter)).not.toBe(BigInt(1));
  });
});
