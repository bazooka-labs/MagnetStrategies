// @vitest-environment jsdom

/**
 * The MagnetFi vault's Learn more modal, and specifically its disclosure.
 *
 * ── Why this file exists ──
 * Until 2026-10-30 this modal explained the seizure ladder in detail — 35%
 * seized, 77% seized, everything seized — and said of the price driving all
 * of it only that "a live oracle prices your collateral". Meanwhile the site
 * told users twice, prominently, that PEX (someone else's protocol) has had
 * no external audit. We disclosed a third party's risk and not our own, on
 * the product that actually holds user collateral in our contracts.
 *
 * These tests are not about layout. Each one pins a statement of fact that a
 * depositor needs and that the contracts can be checked against, so the
 * disclosure cannot be quietly dropped or softened.
 *
 * Every claim was read off the deployed contracts on 2026-10-30:
 *   lean_oracle/contract.py  `update_lp_price` — three asserts, no bound
 *   vault/contract.py        ORACLE_FRESHNESS = 1_800
 *   vault/contract.py        `paused` gates borrowing, not liquidation
 *   AUDIT.md:1077            safe envelope < ~$100k collateral-pool TVL
 */
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LpVaultLearnMore } from "./LpVaultLearnMore";

afterEach(cleanup);

const openIt = () => {
  render(<LpVaultLearnMore />);
  fireEvent.click(screen.getByRole("button", { name: /Learn more/i }));
  return screen.getByText("What you are trusting").closest("div")!.parentElement!;
};

describe("what you are trusting", () => {
  it("says the price comes from one key, with no on-chain limit on its movement", () => {
    const d = openIt();
    expect(within(d).getByText(/One key sets the price/)).toBeTruthy();
    expect(d.textContent).toMatch(/places no limit on how far it may move/);
  });

  it("says the guards are off chain and would not stop a stolen key", () => {
    // The distinction the contract header draws: they catch OUR BUGS. Copy
    // that implied the protections were on chain would be worse than silence.
    const d = openIt();
    expect(d.textContent).toMatch(/run in the\s+bot, off chain/);
    expect(d.textContent).toMatch(/would not stop\s+someone who had stolen the key/);
  });

  it("names the 30-minute staleness window and what it blocks", () => {
    const d = openIt();
    expect(d.textContent).toMatch(/more than 30 minutes old/);
    expect(d.textContent).toMatch(/new borrowing and every\s+liquidation trigger are refused/);
  });

  it("says a pause does NOT stop liquidation", () => {
    /**
     * The claim most likely to be assumed backwards. `paused` gates
     * open_vault and borrow_more only; all three liquidation triggers run
     * regardless. A depositor who believes a pause protects them is wrong in
     * the direction that costs them collateral.
     */
    const d = openIt();
    expect(d.textContent).toMatch(/Pausing does not stop liquidations/);
    expect(d.textContent).toMatch(/will not protect an unhealthy vault/);
  });

  it("states plainly that there has been no external audit", () => {
    const d = openIt();
    expect(within(d).getByText(/no\s+external audit/)).toBeTruthy();
  });

  it("gives the ceiling the internal review set, not just a vague caution", () => {
    // "Reviewed internally" without a number tells a depositor nothing about
    // whether their deposit is inside or outside what was reviewed.
    const d = openIt();
    expect(d.textContent).toMatch(/under roughly \$100k of collateral/);
  });

  it("does not promise an audit that is not coming", () => {
    /**
     * This said "an outside audit is the gate before going past it" until
     * 2026-10-30, when the decision was taken not to commission one at this
     * size. Leaving it would have been a commitment to users that nobody
     * intended to keep — worse than the disclosure it sat inside.
     */
    const d = openIt();
    expect(d.textContent).toMatch(/No outside audit is\s+planned/);
    expect(d.textContent).not.toMatch(/audit is the\s+gate/);
    // And it says what internal review is worth, rather than implying parity.
    expect(d.textContent).toMatch(/shares their blind spots/);
  });

  it("does not describe how to exploit any of it", () => {
    /**
     * The disclosure is a TRUST MODEL — whose key and whose judgement your
     * collateral depends on — not an attack path. The repository is public
     * and the source already states the design openly; a step-by-step failure
     * route adds nothing a depositor can act on.
     */
    const d = openIt();
    const body = (d.textContent ?? "").toLowerCase();
    for (const w of ["exploit", "attack", "drain", "steal from", "manipulate the price"]) {
      expect(body, w).not.toContain(w);
    }
  });
});

describe("the ladder it sits beneath", () => {
  it("still points at the disclosure rather than reassuring on its own", () => {
    // The old line read "a live oracle prices your collateral", which closes
    // the subject. It now opens it.
    const d = openIt();
    const modal = d.closest("[class*='fixed']") ?? document.body;
    expect(modal.textContent).toMatch(/What the oracle is, and what you are trusting it with/);
  });
});
