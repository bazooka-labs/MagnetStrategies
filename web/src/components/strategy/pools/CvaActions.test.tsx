// @vitest-environment jsdom

/**
 * The C-Vault form, MOUNTED.
 *
 * Asserts the rendered DOM, for the reason `LiquidityActions.test.tsx` gives:
 * this component carries long comments about the dollar denomination and the
 * delayed-exit notice, so a source-text check would pass on the prose.
 *
 * The distinction that matters most here is **gate vs notice**. A $5.00 deposit
 * must be ALLOWED with an explanation; an earlier revision refused it outright.
 * A test that only checked for the explanation would pass either way, so these
 * assert the button's `disabled` state too.
 */

import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CvaActions } from "./CvaActions";

afterEach(cleanup);

const HARSH = /\block(ed|out)?\b|frozen|freeze|cannot|can't|unable/i;
const HOLDER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";

type Opts = {
  shares?: number;
  lastDepositRound?: number;
  currentRound?: number;
  algo?: number;
  usdc?: number;
  usdcOptedIn?: boolean;
  depositPaused?: boolean;
  withdrawPaused?: boolean;
  address?: string | null;
};

/** The live vault's globals, so a drift shows up as a failing test. */
const GLOBALS = (o: Opts): Record<string, number> => ({
  deposit_paused: o.depositPaused ? 1 : 0,
  withdraw_paused: o.withdrawPaused ? 1 : 0,
  cva_withdraw_cooldown_rounds: 1200,
  min_cva_withdraw_usd: 5_000_000,
  cva_mint_spread_bps: 20,
  cva_burn_spread_bps: 20,
  max_nav_age_rounds: 5,
  last_nav_update_round: 66_207_187,
  max_cva_deposit_usd_per_call: 0,
  max_cva_withdraw_usd_per_call: 0,
  active_market_0: 1, active_market_1: 2, active_market_2: 0, active_market_3: 0,
  total_nav_usd: 1_640_630_000,
  total_cva_shares: 1_400_654_055,
});

function fakeAlgod(o: Opts) {
  const shares = o.shares ?? 0;
  const user = new Uint8Array(40);
  const dv = new DataView(user.buffer);
  dv.setBigUint64(0, BigInt(Math.round(shares * 1e6)));
  dv.setBigUint64(8, BigInt(o.lastDepositRound ?? 0));
  return {
    status: () => ({ do: async () => ({ lastRound: o.currentRound ?? 66_300_000 }) }),
    getApplicationByID: () => ({
      do: async () => ({
        params: {
          globalState: Object.entries(GLOBALS(o)).map(([k, v]) => ({
            key: Buffer.from(k, "utf8"), value: { uint: v, type: 2 },
          })),
        },
      }),
    }),
    accountInformation: () => ({
      do: async () => ({
        amount: (o.algo ?? 500) * 1e6 + 100_000,
        minBalance: 100_000,
        assets: (o.usdcOptedIn ?? true)
          ? [{ assetId: 31566704, amount: (o.usdc ?? 500) * 1e6 }] : [],
      }),
    }),
    getApplicationBoxByName: () => ({
      do: async () => {
        if (shares <= 0) {
          const e: Error & { status?: number } = new Error("not found");
          e.status = 404;
          throw e;
        }
        return { value: user };
      },
    }),
  } as never;
}

const sign = vi.fn(async () => [null]);

async function openPanel(o: Opts = {}, mode: Mode = "deposit") {
  render(
    <CvaActions
      algoUsd={0.114}
      algod={fakeAlgod(o)}
      address={o.address === undefined ? HOLDER : o.address}
      signTransactions={sign}
      onDone={() => {}}
    />,
  );
  fireEvent.click(screen.getByText("Deposit or withdraw"));
  if (mode === "withdraw") fireEvent.click(screen.getByText("Withdraw"));
  await waitFor(() => expect(document.querySelector("input")).toBeTruthy());
}
type Mode = "deposit" | "withdraw";

/**
 * The withdraw button's label follows the chosen output — "Withdraw as USDC"
 * by default, "Withdraw from C-Vault" when both assets are chosen. Matching
 * either keeps these tests about the GATES rather than about the copy.
 */
const btn = (mode: Mode) => screen.getByRole("button", {
  name: mode === "deposit"
    ? /Deposit to C-Vault/
    : /Withdraw (as USDC|from C-Vault)/,
}) as HTMLButtonElement;

beforeEach(() => { sign.mockClear(); });

describe("the $5.00 deposit", () => {
  it("is ALLOWED, with the exit timing explained", async () => {
    await openPanel({ shares: 0 }, "deposit");
    // $5 of USDC exactly — the amount an earlier revision refused outright.
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "5" } });
    await waitFor(() => expect(btn("deposit").disabled).toBe(false));
    expect(screen.getByText(/Your full exit opens once the vault earns about 0.40%/)).toBeTruthy();
    expect(screen.getByText(/longer if its value falls/)).toBeTruthy();
  });

  it("says nothing once the deposit can exit immediately", async () => {
    await openPanel({ shares: 0 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "25" } });
    await waitFor(() => expect(btn("deposit").disabled).toBe(false));
    expect(screen.queryByText(/Your full exit opens/)).toBeNull();
  });

  it("blocks below the $5.00 minimum", async () => {
    await openPanel({ shares: 0 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "3" } });
    await waitFor(() => expect(screen.getByText(/Minimum deposit is \$5\.00/)).toBeTruthy());
    expect(btn("deposit").disabled).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });

  it("counts the ALGO leg toward the minimum", async () => {
    await openPanel({ shares: 0 }, "deposit");
    // 50 ALGO at $0.114 is $5.70 — over the minimum with no USDC at all.
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "50" } });
    await waitFor(() => expect(btn("deposit").disabled).toBe(false));
  });
});

describe("withdrawals are in dollars", () => {
  it("converts to shares and shows the conversion", async () => {
    await openPanel({ shares: 100, lastDepositRound: 1 }, "withdraw");
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "10" } });
    await waitFor(() => {
      expect(screen.getByText(/vault shares at \$1\.17/)).toBeTruthy();
    });
    // The share count is what gets signed, so the dollar figure must be
    // labelled approximate rather than presented as exact.
    expect(screen.getByText(/exact payout is read from PEX/)).toBeTruthy();
  });

  it("offers a Max that is the whole position", async () => {
    await openPanel({ shares: 100, lastDepositRound: 1 }, "withdraw");
    fireEvent.click(screen.getAllByText("MAX")[0]);
    const input = screen.getAllByPlaceholderText("0")[0] as HTMLInputElement;
    // 100 shares at ~$1.1713 = ~$117.13
    expect(Number(input.value)).toBeCloseTo(117.13, 1);
    await waitFor(() => expect(btn("withdraw").disabled).toBe(false));
  });

  it("blocks under the vault's $5 withdrawal floor", async () => {
    await openPanel({ shares: 100, lastDepositRound: 1 }, "withdraw");
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "2" } });
    // The GATE's wording, not the static helper line — both mention $5.00.
    await waitFor(() => {
      expect(screen.getByText(/Take out at least that much, or all of it/)).toBeTruthy();
    });
    expect(btn("withdraw").disabled).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("the vault's cool-down", () => {
  it("is offered as a duration, with the action disabled", async () => {
    // Deposited 200 rounds ago against a 1,200-round cool-down.
    await openPanel({
      shares: 100, lastDepositRound: 66_300_000 - 200, currentRound: 66_300_000,
    }, "withdraw");
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "10" } });
    await waitFor(() => expect(screen.getByText(/Withdrawals open in/)).toBeTruthy());
    expect(btn("withdraw").disabled).toBe(true);
    expect(document.body.textContent ?? "").not.toMatch(HARSH);
  });

  it("clears once the rounds have passed", async () => {
    await openPanel({
      shares: 100, lastDepositRound: 66_300_000 - 1200, currentRound: 66_300_000,
    }, "withdraw");
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "10" } });
    await waitFor(() => expect(btn("withdraw").disabled).toBe(false));
    expect(screen.queryByText(/Withdrawals open in/)).toBeNull();
  });

  it("never gates a deposit on it", async () => {
    await openPanel({
      shares: 100, lastDepositRound: 66_300_000 - 10, currentRound: 66_300_000,
    }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "25" } });
    await waitFor(() => expect(btn("deposit").disabled).toBe(false));
  });
});

describe("vault state", () => {
  it("reports a paused side, and only that side", async () => {
    await openPanel({ shares: 100, lastDepositRound: 1, depositPaused: true }, "deposit");
    await waitFor(() => {
      expect(screen.getByText(/PEX has paused deposits to this vault/)).toBeTruthy();
    });
    expect(btn("deposit").disabled).toBe(true);
    fireEvent.click(screen.getByText("Withdraw"));
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "10" } });
    await waitFor(() => expect(btn("withdraw").disabled).toBe(false));
  });

  it("says there is nothing to withdraw rather than naming a cool-down", async () => {
    await openPanel({ shares: 0 }, "withdraw");
    await waitFor(() => expect(screen.getByText(/No position in this vault yet/)).toBeTruthy());
    expect(screen.queryByText(/Withdrawals open in/)).toBeNull();
    expect(btn("withdraw").disabled).toBe(true);
  });

  it("asks for a USDC opt-in before offering a payout", async () => {
    await openPanel({ shares: 100, lastDepositRound: 1, usdcOptedIn: false }, "withdraw");
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "10" } });
    await waitFor(() => expect(screen.getByText(/Opt this wallet in to USDC/)).toBeTruthy());
    expect(btn("withdraw").disabled).toBe(true);
  });
});

describe("input handling", () => {
  it("refuses text rather than treating it as zero", async () => {
    await openPanel({ shares: 0 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "1e5" } });
    await waitFor(() => expect(screen.getByText("Enter a number.")).toBeTruthy());
    expect(btn("deposit").disabled).toBe(true);
  });

  it("signs nothing without a wallet", async () => {
    await openPanel({ address: null }, "deposit");
    await waitFor(() => expect(screen.getByText("Connect a wallet to continue.")).toBeTruthy());
    expect(btn("deposit").disabled).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("what the vault exit pays out", () => {
  it("defaults to converting the ALGO leg, in the same signature", async () => {
    await openPanel({ shares: 100, lastDepositRound: 1 }, "withdraw");
    expect(screen.getByRole("button", { name: /Withdraw as USDC/ })).toBeTruthy();
    expect(screen.getByText(/same/)).toBeTruthy();
  });

  it("names the ACTION, not a guaranteed outcome", async () => {
    // "Convert to USDC" rather than "All USDC": a verb is honest about a
    // process that can be partial or fail; a noun claims a result we cannot
    // guarantee. This is the small lie the test exists to stop.
    await openPanel({ shares: 100, lastDepositRound: 1 }, "withdraw");
    expect(screen.getByText("Convert to USDC")).toBeTruthy();
    expect(screen.queryByText("All USDC")).toBeNull();
  });

  it("states the residue, the cost, and what happens if it fails", async () => {
    await openPanel({ shares: 100, lastDepositRound: 1 }, "withdraw");
    // JSX wraps text across elements, so normalise whitespace once and assert
    // against the clean string rather than contorting each matcher.
    const body = (document.body.textContent ?? "").replace(/\s+/g, " ");
    // The four facts a user needs before signing this.
    expect(body).toContain("convert the ALGO for you");
    expect(body).toContain("stays as ALGO");          // the residue
    expect(body).toContain("about 0.4%");             // the cost
    expect(body).toContain("nothing is lost");        // what failure means
    expect(body).toContain("keep the ALGO and can swap it yourself");
  });

  it("offers both assets with no conversion cost", async () => {
    await openPanel({ shares: 100, lastDepositRound: 1 }, "withdraw");
    // An amount, or the button is correctly disabled for having nothing to do.
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "10" } });
    fireEvent.click(screen.getByText("ALGO + USDC"));
    await waitFor(() => expect(screen.getByText(/no conversion, so/)).toBeTruthy());
    expect(screen.queryByText("Convert to USDC")).toBeTruthy();  // the toggle stays
    expect(document.body.textContent ?? "").not.toMatch(/stays as ALGO/); // caveat goes
    expect(btn("withdraw").disabled).toBe(false);
  });
});

/**
 * What a depositor will actually see land.
 *
 * Prompted by a real report: $25.00 deposited, a $24.95 position arrived, and
 * nothing anywhere had said it would. The gap is the 20 bps entry spread and
 * it is entirely predictable, which makes naming it before the signature the
 * whole fix.
 */
describe("the entry spread, before you sign", () => {
  it("names the amount that will arrive, not just the amount going in", async () => {
    await openPanel({ shares: 0 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "25" } });
    await waitFor(() => expect(screen.getByText(/About \$25\.00 in total/)).toBeTruthy());
    // The exact figure from the report. 25 / 1.002 = 24.9501 -> $24.95.
    expect(screen.getByText("≈$24.95")).toBeTruthy();
  });

  it("says where the spread goes, so it does not read as a fee", async () => {
    await openPanel({ shares: 0 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "25" } });
    await waitFor(() => expect(screen.getByText("≈$24.95")).toBeTruthy());
    const body = (document.body.textContent ?? "").replace(/\s+/g, " ");
    expect(body).toContain("stays in the vault");
    expect(body).toContain("not a fee to PEX");
  });

  it("derives the figure the way the contract does, not with a flat multiply", async () => {
    /**
     * cva.teal label51 adds the spread to the NAV DENOMINATOR
     * (`nav + nav*bps/10000`) and then divides, so the credited value is
     * deposit / (1 + s), not deposit * (1 - s). The two diverge as the deposit
     * grows: on $10,000 the division gives $9,980.04 and the multiply $9,980.00.
     * Four cents is not much, but it sits next to a signature, and a figure
     * shown there should be derived the way the chain derives it.
     */
    await openPanel({ shares: 0 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "10000" } });
    await waitFor(() => expect(screen.getByText(/About \$10,?000\.00 in total/)).toBeTruthy());
    expect(screen.getByText("≈$9980.04")).toBeTruthy();
  });

  it("reads the spread off the vault rather than hardcoding 0.2%", async () => {
    // PEX's admin can change it; a hardcoded string would quietly go stale.
    await openPanel({ shares: 0 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[1], { target: { value: "25" } });
    await waitFor(() => expect(screen.getByText("≈$24.95")).toBeTruthy());
    expect(screen.getByText(/0\.20% entry spread/)).toBeTruthy();
  });
});
