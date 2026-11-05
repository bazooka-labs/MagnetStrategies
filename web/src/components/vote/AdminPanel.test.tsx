// @vitest-environment jsdom

/**
 * The Deploy button, which is the only control here that can do something
 * irreversible on mainnet.
 *
 * Three audit rounds kept finding the same failure in different disguises: the
 * panel offers Deploy while an app this wallet already created is invisible to
 * it, and the operator gets a second, permanently inert app. First it was
 * React state lost on unmount, then a confirmation timeout that never reported
 * an id, then a latch that reset when the Admin pill was collapsed.
 *
 * Every version was caught by reading, never by a test, because there were no
 * component tests. These assert the rule the fixes all serve: **Deploy is
 * offered only when the chain has been asked and has answered "none".**
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findDeployedMVote = vi.fn();

vi.mock("@/lib/governanceAdmin", () => ({
  findDeployedMVote: (...a: unknown[]) => findDeployedMVote(...a),
  deployMVote: vi.fn(),
  setupMVote: vi.fn(),
  updateFounder: vi.fn(),
  byteLen: (s: string) => new TextEncoder().encode(s).length,
}));

const ADDR = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    activeAddress: ADDR,
    algodClient: {},
    signTransactions: vi.fn(),
  }),
}));

// GOVERNANCE_LIVE is false (mVote is undeployed), which is the state the panel
// is actually in before a deploy — exactly when Deploy must be correct.
import { AdminPanel } from "./AdminPanel";

const deployButton = () => screen.queryByRole("button", { name: /Deploy mVote/i });

/**
 * A real localStorage, because this jsdom does not supply one.
 *
 * The component guards every access in try/catch — a private window or
 * blocked site data must not break the panel — which means without a working
 * store these tests would silently exercise the degraded path instead of the
 * latch they are named for.
 */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

beforeEach(() => {
  findDeployedMVote.mockReset();
  store.clear();
});
afterEach(cleanup);

describe("Deploy is offered only when the chain says there is nothing", () => {
  it("offers it once a scan has returned no apps", async () => {
    findDeployedMVote.mockResolvedValue([]);
    render(<AdminPanel onProposalCreated={() => {}} />);
    await waitFor(() => expect(deployButton()).toBeTruthy());
  });

  it("withholds it while the scan is still running", () => {
    // Never resolves. "We have not asked yet" is not "there is none".
    findDeployedMVote.mockReturnValue(new Promise(() => {}));
    render(<AdminPanel onProposalCreated={() => {}} />);
    expect(deployButton()).toBeNull();
    expect(screen.getByText(/Checking for an existing deployment/i)).toBeTruthy();
  });

  it("withholds it when the scan FAILED, and says so with a retry", async () => {
    // The dangerous case. Treating an error as "none" is what puts a Deploy
    // button in front of someone who already has an app.
    findDeployedMVote.mockRejectedValue(new Error("429 Too Many Requests"));
    render(<AdminPanel onProposalCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Couldn't check whether this wallet/i)).toBeTruthy());
    expect(deployButton()).toBeNull();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeTruthy();
  });

  it("withholds it when an app already exists, and offers to finish that one", async () => {
    findDeployedMVote.mockResolvedValue([{ appId: 4242, optedIn: false, funded: false }]);
    render(<AdminPanel onProposalCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText(/App 4242/)).toBeTruthy());
    expect(deployButton()).toBeNull();
    expect(screen.getByRole("button", { name: /Finish setup/i })).toBeTruthy();
  });

  it("withholds it after a create was submitted from this wallet, even on a fresh mount", async () => {
    /**
     * The round-four finding, reproduced: collapse the Admin pill while the
     * wallet prompt is open and reopen it, and the old code gave a brand new
     * component with its latch reset and a stale "no apps" scan — one click
     * from a second app.
     *
     * The latch is now persisted per address, so a remount inherits it.
     */
    localStorage.setItem(`mvote:create-submitted:${ADDR}`, "1");
    findDeployedMVote.mockResolvedValue([]);   // node has not seen it yet
    render(<AdminPanel onProposalCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText(/already submitted/i)).toBeTruthy());
    expect(deployButton()).toBeNull();
  });

  it("clears the latch once the app actually shows up", async () => {
    // Otherwise a create that never landed would disable Deploy forever.
    localStorage.setItem(`mvote:create-submitted:${ADDR}`, "1");
    findDeployedMVote.mockResolvedValue([{ appId: 77, optedIn: true, funded: true }]);
    render(<AdminPanel onProposalCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText(/App 77/)).toBeTruthy());
    expect(localStorage.getItem(`mvote:create-submitted:${ADDR}`)).toBeNull();
  });
});
