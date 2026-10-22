// @vitest-environment jsdom

/**
 * The deposit/withdraw form, MOUNTED.
 *
 * These assert the rendered DOM rather than the source text, which matters more
 * here than almost anywhere: the component carries long comments about the
 * cool-down wording and the $5 minimum, so a `toContain("cool-down")` check
 * would pass on the prose while the UI said "locked". Audit 11's structural
 * finding was exactly that — three tests on a money-path component passed under
 * the bugs they claimed to prevent, because the component could not be mounted.
 *
 * Nothing here signs or submits: `signTransactions` is a stub that is asserted
 * never to be called whenever a gate is in force.
 */

import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiquidityActions } from "./LiquidityActions";

afterEach(cleanup);

/** The forbidden register, from the user's own standard. */
const HARSH = /\block(ed|out)?\b|frozen|freeze|cannot|can't|unable/i;

const NOW = 1_789_000_000_000;

type Overrides = {
  shares?: number;
  updatedAtSec?: number;
  algoSpendable?: number;
  usdc?: number;
  usdcOptedIn?: boolean;
  address?: string | null;
};

/**
 * A fake algod good enough for the reads the form makes.
 *
 * `readBalances` calls `accountInformation`; `readMarketGateState` reads the
 * `ml2:` box. Both are stubbed at the client surface rather than mocked at
 * module level, so the real `liquidityPreflight` logic — the SDK cooldown
 * quote included — runs against them.
 */
function fakeAlgod(o: Overrides) {
  const shares = o.shares ?? 0;
  const updatedAt = o.updatedAtSec ?? 0;
  const box = new Uint8Array(16);
  const dv = new DataView(box.buffer);
  dv.setBigUint64(0, BigInt(Math.round(shares * 1e6)));
  dv.setBigUint64(8, BigInt(updatedAt));
  return {
    accountInformation: () => ({
      do: async () => ({
        amount: (o.algoSpendable ?? 100) * 1e6 + 100_000,
        minBalance: 100_000,
        assets: (o.usdcOptedIn ?? true)
          ? [{ assetId: 31566704, amount: (o.usdc ?? 100) * 1e6 }]
          : [],
      }),
    }),
    getApplicationBoxByName: () => ({
      do: async () => {
        if (shares <= 0 && updatedAt === 0) {
          const e: Error & { status?: number } = new Error("not found");
          e.status = 404;
          throw e;
        }
        return { value: box };
      },
    }),
  } as never;
}

const sign = vi.fn(async () => [null]);

function mount(o: Overrides = {}) {
  return render(
    <LiquidityActions
      marketId={1}
      label="ALGO/USD"
      algoUsd={0.114}
      poolValuePerShare={1.13}
      algod={fakeAlgod(o)}
      address={o.address === undefined ? "A4YW55ZEC2TTIN2TEVN56IRVGLWQYQRUNJTPG37OTWE4EJWNAH3EUKHZKA" : o.address}
      signTransactions={sign}
      onDone={() => {}}
    />,
  );
}

/** Open the panel and switch to a mode, waiting for the reads to land. */
async function openPanel(o: Overrides = {}, mode: "deposit" | "withdraw" = "deposit") {
  mount(o);
  fireEvent.click(screen.getByText("Add or remove liquidity"));
  if (mode === "withdraw") fireEvent.click(screen.getByText("Withdraw"));
  // The balance/LP reads are async; wait for one of their effects.
  await waitFor(() => {
    expect(document.querySelector("input")).toBeTruthy();
  });
}

const actionButton = (mode: "deposit" | "withdraw") =>
  screen.getByRole("button", {
    name: mode === "deposit" ? /Deposit to ALGO\/USD/ : /Withdraw from ALGO\/USD/,
  }) as HTMLButtonElement;

beforeEach(() => {
  sign.mockClear();
  vi.setSystemTime(NOW);
});

describe("it starts collapsed", () => {
  it("shows one button and no form until asked", () => {
    mount();
    expect(screen.getByText("Add or remove liquidity")).toBeTruthy();
    expect(document.querySelector("input")).toBeNull();
  });
});

describe("the withdrawal cool-down", () => {
  it("is offered as a duration, with the action disabled", async () => {
    // Deposited 10 minutes ago: 50 minutes of the hour remain.
    await openPanel({ shares: 5, updatedAtSec: NOW / 1000 - 600 }, "withdraw");
    await waitFor(() => {
      expect(screen.getByText(/Withdrawals open in/)).toBeTruthy();
    });
    expect(screen.getByText(/Withdrawals open in 50 minutes/)).toBeTruthy();
    expect(actionButton("withdraw").disabled).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });

  it("never uses the harsh register anywhere on screen", async () => {
    await openPanel({ shares: 5, updatedAtSec: NOW / 1000 - 600 }, "withdraw");
    await waitFor(() => expect(screen.getByText(/Withdrawals open in/)).toBeTruthy());
    // The whole rendered panel, not one string: this is what the user reads.
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(HARSH);
  });

  it("enables the action once the hour has passed", async () => {
    await openPanel({ shares: 5, updatedAtSec: NOW / 1000 - 3600 }, "withdraw");
    await waitFor(() => expect(actionButton("withdraw").disabled).toBe(false));
    expect(screen.queryByText(/Withdrawals open in/)).toBeNull();
  });

  it("does not gate a DEPOSIT on the cool-down", async () => {
    // Gating deposits on it would shut a user out of their own top-up for an
    // hour after every deposit.
    await openPanel({ shares: 5, updatedAtSec: NOW / 1000 - 60 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "100" } });
    await waitFor(() => expect(actionButton("deposit").disabled).toBe(false));
  });

  it("warns that a top-up restarts the cool-down on the whole position", async () => {
    await openPanel({ shares: 5, updatedAtSec: NOW / 1000 - 60 }, "deposit");
    await waitFor(() => {
      expect(screen.getByText(/restarts the 1 hour withdrawal cool-down on all of it/)).toBeTruthy();
    });
    // The specific claim that matters: not only the new money.
    expect(screen.getByText(/not only on the amount you add/)).toBeTruthy();
  });

  it("does not warn when there is no existing position to re-lock", async () => {
    await openPanel({ shares: 0, updatedAtSec: 0 }, "deposit");
    expect(screen.queryByText(/restarts the 1 hour/)).toBeNull();
  });
});

describe("nothing to withdraw", () => {
  it("says so plainly rather than naming a cool-down", async () => {
    await openPanel({ shares: 0, updatedAtSec: 0 }, "withdraw");
    await waitFor(() => {
      expect(screen.getByText(/No position in this pool yet/)).toBeTruthy();
    });
    expect(screen.queryByText(/Withdrawals open in/)).toBeNull();
    expect(actionButton("withdraw").disabled).toBe(true);
  });
});

describe("the $5 minimum", () => {
  it("blocks a deposit under it and names the figure", async () => {
    await openPanel({ shares: 0 }, "deposit");
    // 10 ALGO at $0.114 is $1.14.
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "10" } });
    await waitFor(() => {
      expect(screen.getByText(/Minimum deposit is \$5\.00/)).toBeTruthy();
    });
    expect(actionButton("deposit").disabled).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });

  it("allows a deposit over it", async () => {
    await openPanel({ shares: 0 }, "deposit");
    // 100 ALGO at $0.114 is $11.40.
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "100" } });
    await waitFor(() => expect(actionButton("deposit").disabled).toBe(false));
  });

  it("counts both legs toward the minimum, not just one", async () => {
    await openPanel({ shares: 0 }, "deposit");
    const [algo, usdc] = screen.getAllByPlaceholderText("0");
    // $1.14 of ALGO alone is under; with $6 of USDC the deposit is over.
    fireEvent.change(algo, { target: { value: "10" } });
    fireEvent.change(usdc, { target: { value: "6" } });
    await waitFor(() => expect(actionButton("deposit").disabled).toBe(false));
  });
});

describe("input handling", () => {
  it("refuses text rather than silently treating it as zero", async () => {
    await openPanel({ shares: 0 }, "deposit");
    fireEvent.change(screen.getAllByPlaceholderText("0")[0], { target: { value: "1e5" } });
    await waitFor(() => expect(screen.getByText("Enter a number.")).toBeTruthy());
    expect(actionButton("deposit").disabled).toBe(true);
  });

  it("does nothing on an empty form", async () => {
    await openPanel({ shares: 0 }, "deposit");
    expect(actionButton("deposit").disabled).toBe(true);
  });

  it("leaves fee headroom when MAX is used on the ALGO leg", async () => {
    // Spending the whole spendable balance would fail the balance gate, since
    // the group's own fee comes out of the same pot.
    await openPanel({ shares: 0, algoSpendable: 10 }, "deposit");
    const maxButtons = screen.getAllByText("MAX");
    fireEvent.click(maxButtons[0]);
    const algo = screen.getAllByPlaceholderText("0")[0] as HTMLInputElement;
    expect(Number(algo.value)).toBeLessThan(10);
    expect(Number(algo.value)).toBeGreaterThan(9.9);
  });
});

describe("without a wallet", () => {
  it("asks for one and signs nothing", async () => {
    mount({ address: null });
    fireEvent.click(screen.getByText("Add or remove liquidity"));
    await waitFor(() => {
      expect(screen.getByText("Connect a wallet to continue.")).toBeTruthy();
    });
    expect(actionButton("deposit").disabled).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });
});
