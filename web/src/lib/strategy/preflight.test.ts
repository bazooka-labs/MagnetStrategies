import { describe, it, expect } from "vitest";
import {
  directCooldownGate, cvaCooldownGate, phrase, cvaDepositGate,
  cvaWithdrawableAfterRoundTrip, CVA_MIN_DEPOSIT_USD, CVA_COOLDOWN_ROUNDS_FALLBACK,
  cvaPauseGate, perCallCapGate, allocationStatusGate, marksRequired,
  balanceGates, marketGates, depositRestartsCooldown, primaryGate,
  type CvaVaultState, type Balances,
} from "./preflight";
import { storagePaymentFor, LP_BOX_MBR_MICRO_ALGO } from "./group";

// The live vault on 2026-10-21, so a drift in these shows up as a test failure
// rather than as a wrong gate.
const LIVE: CvaVaultState = {
  depositPaused: false, withdrawPaused: false,
  cooldownRounds: 1200, minWithdrawUsd: 5, mintSpreadBps: 20, burnSpreadBps: 20,
  maxNavAgeRounds: 5, lastNavUpdateRound: 66207187,
  maxDepositUsdPerCall: 0, maxWithdrawUsdPerCall: 0,
  activeMarkets: [1, 2],
};

const RICH: Balances = { algoSpendableMicro: 500_000_000, usdcMicro: 500_000_000, usdcOptedIn: true };

describe("direct-pool cooldown", () => {
  // The values are a real ml2: box: shares 0.92902, updated_at 1788959649.
  const dep = 1788959649;

  it("blocks for the full hour and clears exactly on the boundary", () => {
    expect(directCooldownGate(dep, dep)).not.toBeNull();
    expect(directCooldownGate(dep, dep + 3599)).not.toBeNull();
    // `>=` in the bytecode, so the boundary round itself is allowed.
    expect(directCooldownGate(dep, dep + 3600)).toBeNull();
    expect(directCooldownGate(dep, dep + 7200)).toBeNull();
  });

  it("does not gate a wallet that has never deposited", () => {
    // `extract_uint64` on a zero word gives 0, and 0 + 3600 is long past — the
    // chain allows it, so offering it is correct.
    expect(directCooldownGate(0, dep)).toBeNull();
  });

  it("counts down rather than repeating one message", () => {
    const a = directCooldownGate(dep, dep + 60)!;
    const b = directCooldownGate(dep, dep + 1800)!;
    expect(a.retryAfterSec).toBe(3540);
    expect(b.retryAfterSec).toBe(1800);
    expect(a.message).not.toBe(b.message);
  });

  it("flags that a top-up restarts the whole position's cool-down", () => {
    expect(depositRestartsCooldown({ shares: 0.9, updatedAtSec: dep })).toBe(true);
    expect(depositRestartsCooldown({ shares: 0, updatedAtSec: 0 })).toBe(false);
    expect(depositRestartsCooldown(null)).toBe(false);
  });
});

describe("C-Vault cooldown", () => {
  // A real gu2: box pair — deposited at 65154825, withdrew at 65156258, which
  // is 1433 rounds later. That withdrawal had to clear 1200, and does.
  it("agrees with the live withdrawal that cleared it", () => {
    expect(cvaCooldownGate(65154825, 65156258, 1200)).toBeNull();
    expect(cvaCooldownGate(65154825, 65154825 + 1199, 1200)).not.toBeNull();
    expect(cvaCooldownGate(65154825, 65154825 + 1200, 1200)).toBeNull();
  });

  it("is skipped when the global is zero, as the contract's `bz` is", () => {
    expect(cvaCooldownGate(65154825, 65154826, 0)).toBeNull();
  });

  it("phrases 1200 rounds as about an hour", () => {
    const g = cvaCooldownGate(66207187, 66207187, CVA_COOLDOWN_ROUNDS_FALLBACK)!;
    expect(g.retryAfterSec).toBe(3360);
    expect(g.message).toBe("Withdrawals open in 56 minutes");
  });
});

describe("cool-down copy", () => {
  it("always names a duration", () => {
    expect(phrase(30)).toBe("under a minute");
    expect(phrase(600)).toBe("10 minutes");
    expect(phrase(3600)).toBe("1 hour");
    expect(phrase(3900)).toBe("1h 5m");
    expect(phrase(7200)).toBe("2 hours");
  });

  it("uses no harsh language anywhere a gate can speak", () => {
    // The user's standard: "1hr soft lock or cool-down is more user friendly
    // wording than lockout or can not withdraw."
    const harsh = /lock|locked|lockout|frozen|freeze|cannot|can't|forbidden|denied/i;
    const messages = [
      directCooldownGate(1788959649, 1788959649)!.message,
      cvaCooldownGate(100, 100, 1200)!.message,
      cvaPauseGate({ ...LIVE, depositPaused: true }, "deposit")!.message,
      cvaPauseGate({ ...LIVE, withdrawPaused: true }, "withdraw")!.message,
      perCallCapGate(1000, 500, "deposit")!.message,
      allocationStatusGate(3, "deposit")!.message,
      cvaDepositGate({ depositUsd: 1, minWithdrawUsd: 5, mintSpreadBps: 20, burnSpreadBps: 20 })!.message,
      ...balanceGates({
        balances: { algoSpendableMicro: 0, usdcMicro: 0, usdcOptedIn: false },
        algoLegMicro: 1e6, usdcLegMicro: 1e6, groupFeeMicro: 5000,
        storagePayMicro: 0, needsUsdcOptIn: true,
      }).map((g) => g.message),
      ...phraseSamples(),
    ];
    for (const m of messages) expect(m, m).not.toMatch(harsh);
  });

  function phraseSamples() {
    return [30, 600, 3600, 3900].map((s) => `Withdrawals open in ${phrase(s)}`);
  }
});

describe("the $5 dust trap", () => {
  it("reproduces the exact shortfall that motivated the $5.25 minimum", () => {
    const out = cvaWithdrawableAfterRoundTrip(5, 20, 20);
    expect(out).toBeCloseTo(4.98003992, 8);
    expect(out).toBeLessThan(5);
  });

  it("refuses a deposit that could never be fully withdrawn", () => {
    const g = cvaDepositGate({ depositUsd: 5, minWithdrawUsd: 5, mintSpreadBps: 20, burnSpreadBps: 20 });
    expect(g?.code).toBe("below_minimum");
  });

  it("clears the floor at the product minimum, with headroom", () => {
    expect(cvaDepositGate({
      depositUsd: CVA_MIN_DEPOSIT_USD, minWithdrawUsd: 5, mintSpreadBps: 20, burnSpreadBps: 20,
    })).toBeNull();
    const out = cvaWithdrawableAfterRoundTrip(CVA_MIN_DEPOSIT_USD, 20, 20);
    expect(out / 5 - 1).toBeGreaterThan(0.04);
  });

  it("still catches the trap if PEX widens the spreads", () => {
    // $5.25 only clears a $5 floor while the round trip costs under ~4.5%. At
    // 300 bps each way it does not, and the gate must notice rather than rely
    // on the constant.
    const g = cvaDepositGate({
      depositUsd: CVA_MIN_DEPOSIT_USD, minWithdrawUsd: 5, mintSpreadBps: 300, burnSpreadBps: 300,
    });
    expect(g?.code).toBe("below_exit_floor");
  });

  it("still catches the trap if PEX raises the floor", () => {
    const g = cvaDepositGate({
      depositUsd: 6, minWithdrawUsd: 10, mintSpreadBps: 20, burnSpreadBps: 20,
    });
    expect(g?.code).toBe("below_exit_floor");
  });
});

describe("vault state gates", () => {
  it("passes everything on the live configuration", () => {
    expect(cvaPauseGate(LIVE, "deposit")).toBeNull();
    expect(cvaPauseGate(LIVE, "withdraw")).toBeNull();
    // Live caps are 0 = unlimited, so a large amount must not be gated.
    expect(perCallCapGate(1_000_000, LIVE.maxDepositUsdPerCall, "deposit")).toBeNull();
  });

  it("gates each pause flag only on its own side", () => {
    const d = { ...LIVE, depositPaused: true };
    expect(cvaPauseGate(d, "deposit")?.code).toBe("deposit_paused");
    expect(cvaPauseGate(d, "withdraw")).toBeNull();
    const w = { ...LIVE, withdrawPaused: true };
    expect(cvaPauseGate(w, "withdraw")?.code).toBe("withdraw_paused");
    expect(cvaPauseGate(w, "deposit")).toBeNull();
  });

  it("treats a per-call cap as a limit only once set", () => {
    expect(perCallCapGate(600, 500, "deposit")?.code).toBe("per_call_cap");
    expect(perCallCapGate(500, 500, "deposit")).toBeNull();
    expect(perCallCapGate(1e9, 0, "withdraw")).toBeNull();
  });

  it("blocks deposits to a withdraw-only market but not exits from it", () => {
    expect(allocationStatusGate(3, "deposit")?.code).toBe("allocation_withdraw_only");
    expect(allocationStatusGate(3, "withdraw")).toBeNull();
    expect(allocationStatusGate(1, "deposit")).toBeNull();
  });

  it("requires a mark leg per active market that holds shares", () => {
    expect(marksRequired(LIVE, [1, 2])).toEqual([1, 2]);
    // An allocation at zero shares is skipped by the contract's `bz`, so it
    // needs no mark and no extra transaction in the group.
    expect(marksRequired(LIVE, [1])).toEqual([1]);
    expect(marksRequired(LIVE, [])).toEqual([]);
    // A market the vault no longer lists never needs one.
    expect(marksRequired({ ...LIVE, activeMarkets: [1] }, [1, 2])).toEqual([1]);
  });
});

describe("balance preflight", () => {
  it("counts fees and the storage payment, not just the leg", () => {
    const g = balanceGates({
      balances: { algoSpendableMicro: 1_000_000, usdcMicro: 0, usdcOptedIn: true },
      algoLegMicro: 1_000_000, usdcLegMicro: 0, groupFeeMicro: 8_000,
      storagePayMicro: 100_000, needsUsdcOptIn: false,
    });
    expect(g.map((x) => x.code)).toEqual(["insufficient_algo"]);
    expect(g[0].message).toContain("1.108");
  });

  it("measures against spendable balance, not the headline one", () => {
    // 1 ALGO held, 0.9 of it locked as min-balance: a 0.5 ALGO deposit fails.
    const balances = { algoSpendableMicro: 100_000, usdcMicro: 0, usdcOptedIn: true };
    expect(balanceGates({
      balances, algoLegMicro: 500_000, usdcLegMicro: 0,
      groupFeeMicro: 5_000, storagePayMicro: 0, needsUsdcOptIn: false,
    }).map((x) => x.code)).toEqual(["insufficient_algo"]);
  });

  it("catches a missing USDC opt-in before a payout is offered", () => {
    const g = balanceGates({
      balances: { algoSpendableMicro: 1e9, usdcMicro: 0, usdcOptedIn: false },
      algoLegMicro: 0, usdcLegMicro: 0, groupFeeMicro: 5_000,
      storagePayMicro: 0, needsUsdcOptIn: true,
    });
    expect(g.map((x) => x.code)).toEqual(["no_usdc_optin"]);
  });

  it("passes a funded wallet", () => {
    expect(balanceGates({
      balances: RICH, algoLegMicro: 1e6, usdcLegMicro: 1e6,
      groupFeeMicro: 8_000, storagePayMicro: 100_000, needsUsdcOptIn: true,
    })).toEqual([]);
  });
});

describe("market-pool gates", () => {
  const now = 1789000000;
  const base = {
    balances: RICH, nowSec: now,
    algoLegMicro: 1_000_000, usdcLegMicro: 1_000_000,
    groupFeeMicro: 8_000, storagePayMicro: 100_000,
  };

  it("never gates a deposit on the cool-down", () => {
    // The cool-down is a WITHDRAWAL gate. Gating deposits on it would lock a
    // user out of their own top-up for an hour after every deposit.
    const g = marketGates({
      ...base, action: "deposit",
      state: { shares: 5, updatedAtSec: now - 10 },
    });
    expect(g).toEqual([]);
  });

  it("gates a withdrawal inside the window", () => {
    const g = marketGates({
      ...base, action: "withdraw",
      state: { shares: 5, updatedAtSec: now - 10 },
    });
    expect(g.map((x) => x.code)).toEqual(["cooldown"]);
  });

  it("says there is nothing to withdraw rather than naming a cool-down", () => {
    const g = marketGates({
      ...base, action: "withdraw", state: { shares: 0, updatedAtSec: 0 },
    });
    expect(g.map((x) => x.code)).toEqual(["nothing_to_withdraw"]);
  });

  it("requires a USDC opt-in to withdraw but not to deposit", () => {
    const balances = { algoSpendableMicro: 1e9, usdcMicro: 1e9, usdcOptedIn: false };
    const state = { shares: 5, updatedAtSec: now - 7200 };
    expect(marketGates({ ...base, balances, action: "withdraw", state })
      .map((x) => x.code)).toEqual(["no_usdc_optin"]);
    // A deposit sends USDC out; it cannot send what it does not hold, and that
    // is the insufficient-USDC gate's job, not the opt-in one's.
    expect(marketGates({ ...base, balances, action: "deposit", state })
      .map((x) => x.code)).toEqual([]);
  });

  it("clears a withdrawal once the hour has passed", () => {
    expect(marketGates({
      ...base, action: "withdraw", state: { shares: 5, updatedAtSec: now - 3600 },
    })).toEqual([]);
  });

  it("reports the cool-down first when a wallet is also short of ALGO", () => {
    const g = marketGates({
      ...base, action: "withdraw",
      balances: { algoSpendableMicro: 0, usdcMicro: 0, usdcOptedIn: true },
      state: { shares: 5, updatedAtSec: now - 10 },
    });
    expect(primaryGate(g)?.code).toBe("cooldown");
  });
});

describe("the first-deposit box MBR", () => {
  it("is charged exactly once, and never to a returning depositor", () => {
    // AdminOps asserts equality in BOTH directions — the MBR on a first
    // deposit, zero afterwards — so neither value is a safe default.
    expect(storagePaymentFor(false)).toBe(LP_BOX_MBR_MICRO_ALGO);
    expect(storagePaymentFor(true)).toBe(BigInt(0));
    expect(LP_BOX_MBR_MICRO_ALGO).toBe(BigInt(26_500));
  });

  it("is counted toward the ALGO a first-time depositor needs", () => {
    // 1 ALGO spendable, depositing 0.93. With the 55,000 fee that is 0.985 and
    // fits; adding the 26,500 MBR makes it 1.0115 and does not. So the MBR is
    // the deciding term, which is the point of the test.
    const balances = { algoSpendableMicro: 1_000_000, usdcMicro: 50_000_000, usdcOptedIn: true };
    const withBox = marketGates({
      action: "deposit", state: { shares: 0, updatedAtSec: 0 }, balances,
      nowSec: 1_789_000_000, algoLegMicro: 930_000, usdcLegMicro: 0,
      groupFeeMicro: 55_000, storagePayMicro: Number(LP_BOX_MBR_MICRO_ALGO),
    });
    expect(withBox.map((g) => g.code)).toEqual(["insufficient_algo"]);
    // The same deposit by someone who already holds the box fits.
    const returning = marketGates({
      action: "deposit", state: { shares: 5, updatedAtSec: 1 }, balances,
      nowSec: 1_789_000_000, algoLegMicro: 930_000, usdcLegMicro: 0,
      groupFeeMicro: 55_000, storagePayMicro: 0,
    });
    expect(returning).toEqual([]);
  });
});
