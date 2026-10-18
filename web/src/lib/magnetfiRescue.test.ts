/**
 * Preconditions for unlocking a zero-debt vault.
 *
 * The rescue borrows 1 micro-mUSD and repays it in the same atomic group so
 * that pay_interest's close branch — which needs `principal_paid > 0` — can
 * fire and return the collateral. Every condition below is one the CONTRACT
 * enforces; checking them here only decides whether the user gets a sentence
 * or an opaque revert. Getting one wrong cannot move funds, but it can send
 * someone away believing their collateral is unreachable when it is not.
 *
 * Pure function by design: the send path re-reads the position and calls this
 * again at send time, so the panel's copy being a refresh out of date cannot
 * produce a group that was never going to succeed.
 */
import { describe, expect, it } from "vitest";
import { rescueBlockedReason } from "./magnetfiClient";
import type { VaultPosition } from "./magnetfiReads";

/** A fixed clock, so "overdue" is decided by the fixture and not by the date. */
const NOW = 1_800_000_000;
const DAY = 86_400;

const pos = (o: Partial<VaultPosition> = {}): VaultPosition => ({
  lpAmount: 1_000, musdBorrowed: 0, accruedInterest: 0,
  // Paid recently by default. `lastPaymentTs: 0` would read as 90 days
  // overdue against any real clock — which is how the lazy-overdue check
  // below announced itself when it was added.
  rateBps: 800, lastAccrualTs: NOW - DAY, lastPaymentTs: NOW - DAY,
  vaultState: 0, ...o,
});

describe("when the rescue is allowed", () => {
  it("allows the exact case it exists for: collateral, no debt, active", () => {
    expect(rescueBlockedReason(pos(), NOW)).toBeNull();
  });
});

describe("when it is refused", () => {
  it("refuses a vault that has debt, and points at the normal path", () => {
    // Not a safety issue — Repay & Close handles this — but silently running
    // the rescue would borrow 1 micro-mUSD and fail to close, which looks
    // like a broken button.
    expect(rescueBlockedReason(pos({ musdBorrowed: 100 }), NOW)).toMatch(/Repay & Close/);
  });

  it("refuses a vault in liquidation", () => {
    // vault_state 2: pay_interest asserts != 2, and only the admin can settle.
    expect(rescueBlockedReason(pos({ vaultState: 2 }), NOW)).toMatch(/liquidation/);
  });

  it("refuses an overdue vault and says how to clear it", () => {
    // borrow_more asserts vault_state == 0. _lazy_overdue_check flips ANY
    // vault to 1 after 90 days without a payment, debt or not — so this is
    // the state a long-forgotten trapped vault actually ends up in, and the
    // message has to carry the way out.
    const r = rescueBlockedReason(pos({ vaultState: 1 }), NOW);
    expect(r).toMatch(/overdue/);
    expect(r).toMatch(/Pay Interest/);
    expect(r).toMatch(/refunded/);
  });

  it("refuses a vault the CONTRACT will treat as overdue, even if the box says active", () => {
    // _lazy_overdue_check recomputes this at execution time from
    // last_payment_timestamp, and borrow_more asserts state 0 AFTER it runs.
    // A stored 0 is therefore not enough — and this is the normal state of a
    // trapped vault, since nobody has touched it for 90 days by definition.
    const stale = pos({ vaultState: 0, lastPaymentTs: NOW - 91 * DAY });
    expect(rescueBlockedReason(stale, NOW)).toMatch(/overdue/);
  });

  it("allows a vault one day inside the window", () => {
    expect(rescueBlockedReason(pos({ lastPaymentTs: NOW - 89 * DAY }), NOW)).toBeNull();
  });

  it("keeps every message short enough for the toast to show whole", () => {
    // The toast slices at 260. The overdue message ran 211 against a 140-char
    // slice and lost its entire remedy, while a test asserting the string
    // contained that remedy still passed.
    const cases = [
      rescueBlockedReason(null, NOW),
      rescueBlockedReason(pos({ musdBorrowed: 1 }), NOW),
      rescueBlockedReason(pos({ vaultState: 2 }), NOW),
      rescueBlockedReason(pos({ lastPaymentTs: NOW - 91 * DAY }), NOW),
      rescueBlockedReason(pos({ lpAmount: 0 }), NOW),
    ];
    for (const m of cases) {
      expect(m).not.toBeNull();
      expect(m!.length, `too long for the toast: ${m}`).toBeLessThanOrEqual(260);
    }
  });

  it("refuses a vault with nothing to return", () => {
    expect(rescueBlockedReason(pos({ lpAmount: 0 }), NOW)).toMatch(/no collateral/);
  });

  it("refuses when there is no position at all", () => {
    expect(rescueBlockedReason(null, NOW)).toMatch(/No vault position/);
  });

  it("reports debt before overdue when a vault is both", () => {
    // Ordering is deliberate: "use the other button" is actionable, "your
    // vault is overdue" sends someone hunting a problem they do not have.
    expect(rescueBlockedReason(pos({ musdBorrowed: 100, vaultState: 1 }), NOW))
      .toMatch(/Repay & Close/);
  });
});

/**
 * The other half of the same defect: creating the trap, not escaping it.
 *
 * rescueZeroDebtVault exists because open_vault(pool, 0) is reachable on
 * chain. openVault is the one entry point every caller in this app goes
 * through, so it refuses the zero-borrow case rather than relying on a single
 * React `disabled` condition staying correct through future edits.
 *
 * Asserted by calling it — the throw happens before any client or network
 * work, so no algod is needed and a passing test proves the guard runs first.
 */
import { openVault } from "./magnetfiClient";

describe("openVault refuses to create an inescapable vault", () => {
  const noAlgod = {} as never;

  it("rejects a zero borrow", async () => {
    await expect(openVault(noAlgod, "ADDR", 100, 0)).rejects.toThrow(/non-zero amount/);
  });

  it("rejects a negative borrow", async () => {
    await expect(openVault(noAlgod, "ADDR", 100, -5)).rejects.toThrow(/non-zero amount/);
  });

  it("rejects NaN rather than passing it to toBase", async () => {
    // `!(x > 0)` catches NaN where `x <= 0` would not — a NaN borrow would
    // otherwise reach toBase and become an unpredictable base amount.
    await expect(openVault(noAlgod, "ADDR", 100, Number.NaN)).rejects.toThrow(/non-zero amount/);
  });
});
