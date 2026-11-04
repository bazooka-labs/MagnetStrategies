// @vitest-environment jsdom

/**
 * The gate on the collateral test page.
 *
 * The nav entry is hidden from non-admins, but that is a convenience: the
 * route is public, it ships in the client bundle, and anyone can type it. So
 * the page must refuse to offer any control that spends money to a wallet
 * that is not the admin — which is what these pin.
 *
 * Not a security boundary either way. The real authority is the signature,
 * and PEX would accept these groups from any wallet willing to sign them.
 * This stops the page being used by accident, and that is all it claims.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  isConnected: false,
  address: null as string | null,
  signTransactions: vi.fn(),
}));
vi.mock("@/hooks/useWallet", () => ({ useWallet: () => wallet }));
vi.mock("@/hooks/usePerpsMarket", () => ({
  usePerpsMarket: () => ({ data: null, loading: false, error: null }),
  oracleAgeSeconds: () => 0,
}));
const positionsFor = vi.hoisted(() => ({ owner: undefined as unknown }));
vi.mock("@/hooks/usePerpsPositions", () => ({
  usePerpsPositions: (owner: unknown) => {
    positionsFor.owner = owner;
    return { positions: [], loading: false, error: null, refresh: () => {} };
  },
}));

import { AdminCollateralTest } from "./AdminCollateralTest";
import { MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";

afterEach(() => {
  cleanup();
  wallet.isConnected = false;
  wallet.address = null;
});

describe("it offers nothing to anyone but the admin", () => {
  it("shows no controls when disconnected", () => {
    render(<AdminCollateralTest />);
    expect(screen.queryByRole("button", { name: /open position/i })).toBeNull();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("shows no controls to a connected NON-admin wallet", () => {
    wallet.isConnected = true;
    wallet.address = "SOMEONEELSESOMEONEELSESOMEONEELSESOMEONEELSESOMEONEEL";
    render(<AdminCollateralTest />);
    expect(screen.queryByRole("button", { name: /open position/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^ALGO$/ })).toBeNull();
  });

  it("does not even READ a non-admin's positions", () => {
    // The page passes null rather than the connected address, so a stray
    // visitor's wallet is not enumerated against the exchange on page load.
    wallet.isConnected = true;
    wallet.address = "SOMEONEELSESOMEONEELSESOMEONEELSESOMEONEELSESOMEONEEL";
    render(<AdminCollateralTest />);
    expect(positionsFor.owner).toBeNull();
  });

  it("shows the controls to the admin wallet", () => {
    wallet.isConnected = true;
    wallet.address = MAGNETFI_ADMIN_ADDRESS;
    render(<AdminCollateralTest />);
    expect(screen.getByRole("button", { name: /open position/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^ALGO$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^USDC$/ })).toBeTruthy();
  });

  it("keeps the open button disabled until there is a usable quote", () => {
    wallet.isConnected = true;
    wallet.address = MAGNETFI_ADMIN_ADDRESS;
    render(<AdminCollateralTest />);
    // usePerpsMarket is stubbed with no data, so no quote can exist.
    expect(screen.getByRole("button", { name: /open position/i })
      .hasAttribute("disabled")).toBe(true);
  });
});

describe("it says what it refuses", () => {
  it("states that protection is not offered on this page", () => {
    wallet.isConnected = true;
    wallet.address = MAGNETFI_ADMIN_ADDRESS;
    render(<AdminCollateralTest />);
    // The warning is the only place a user is told why there is no TP/SL.
    expect(screen.getByText(/take-profit or stop/i)).toBeTruthy();
    expect(screen.getByText(/keeper/i)).toBeTruthy();
  });
});
