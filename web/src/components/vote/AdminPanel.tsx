"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Rocket, PlusCircle, Copy, Check, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { Panel, PrimaryButton } from "@/components/magnetfi/v2/shared";
import { CreateProposalModal } from "@/components/vote/CreateProposalModal";
import {
  deployMVote, findDeployedMVote, setupMVote, updateFounder, type DeployStep,
} from "@/lib/governanceAdmin";
import { GOVERNANCE_LIVE, GOVERNANCE_NETWORK, MVOTE } from "@/lib/governance";

/**
 * "This wallet has already submitted a create" — outside React, and persisted.
 *
 * It lived in component state, which meant it reset whenever the Admin pill
 * was collapsed and reopened, and was not shared with a second tab. An audit
 * walked the remaining path: click Deploy, collapse the pill while the wallet
 * prompt is open, reopen, approve. The remounted panel's scan had already run
 * and found nothing, nothing rescans it, and the enabled Deploy button is one
 * click from a second app on mainnet.
 *
 * Keyed by address because the latch is a fact about a wallet, not a browser.
 * localStorage can throw or be cleared, so every access is guarded and the
 * scan below is the real defence — this only closes the window before the
 * chain can answer.
 */
const latchKey = (addr: string) => `mvote:create-submitted:${addr}`;

function readLatch(addr: string): boolean {
  try { return localStorage.getItem(latchKey(addr)) === "1"; } catch { return false; }
}
function writeLatch(addr: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(latchKey(addr), "1");
    else localStorage.removeItem(latchKey(addr));
  } catch { /* private window, blocked storage — the scan still covers us */ }
}

export function AdminPanel({ onProposalCreated, founder }: {
  onProposalCreated: () => void;
  /** The on-chain founder, or null if not deployed / unreadable. */
  founder?: string | null;
}) {
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [showCreate, setShowCreate] = useState(false);

  // deploy handshake state
  const [step, setStep] = useState<DeployStep | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * mVote apps this wallet has already created, read from the chain.
   *
   * Not React state carried across the handshake: the panel unmounts whenever
   * the Admin pill is collapsed, and a create whose confirmation timed out
   * never produced an id to carry. Both left the operator with an enabled
   * Deploy button and a real app they could not name.
   */
  const [found, setFound] = useState<{ appId: number; optedIn: boolean; funded: boolean }[] | null>(null);
  /** Latches once a create has been SUBMITTED, confirmed or not. Persisted. */
  const [createSubmitted, setCreateSubmitted] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  /** Only the newest scan may write, so a wallet switch cannot be overwritten. */
  const scanSeq = useRef(0);

  const scan = useCallback(async () => {
    const seq = ++scanSeq.current;
    if (!activeAddress || !algodClient) { setFound(null); setScanFailed(false); return; }
    try {
      const apps = await findDeployedMVote(algodClient, activeAddress);
      if (seq !== scanSeq.current) return;
      setFound(apps);
      setScanFailed(false);
      // The chain has answered. If it found an app the latch has done its job;
      // if it found none, a previously submitted create never landed and
      // holding the button hostage forever helps nobody.
      if (apps.length > 0) writeLatch(activeAddress, false);
    } catch {
      if (seq !== scanSeq.current) return;
      setFound(null);          // unknown, which is NOT "none"
      setScanFailed(true);
    }
  }, [activeAddress, algodClient]);

  useEffect(() => {
    setCreateSubmitted(activeAddress ? readLatch(activeAddress) : false);
    void scan();
  }, [scan, activeAddress]);

  /*
    Keep looking while there is still a Deploy button to press.

    The mount scan is a single snapshot, and the dangerous moment is precisely
    when a create is in flight and the node has not seen it yet. Re-running on
    a timer and whenever the tab regains focus means the app appears on its own
    rather than only after a reload.
  */
  useEffect(() => {
    if (found && found.length > 0) return;      // nothing left to watch for
    const id = setInterval(() => void scan(), 10_000);
    const onVisible = () => { if (!document.hidden) void scan(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [scan, found]);

  /** Set the moment step 1 confirms, so a failed step 2 cannot lose the App ID. */
  const [needsSetup, setNeedsSetup] = useState(false);

  async function handleDeploy() {
    if (!activeAddress || !algodClient) return;

    // Ask the chain one more time, immediately. Everything above this is a
    // snapshot that may be seconds old, and the cost of acting on a stale one
    // is a second app nobody wanted.
    try {
      const existing = await findDeployedMVote(algodClient, activeAddress);
      if (existing.length > 0) {
        setFound(existing);
        toast.error(`This wallet already created mVote app ${existing[0].appId}. `
          + "Finish its setup rather than deploying again.");
        return;
      }
    } catch {
      toast.error("Couldn't check for an existing deployment. Not deploying — try again.");
      return;
    }

    setCreateSubmitted(true);
    writeLatch(activeAddress, true);
    try {
      const { appId } = await deployMVote(
        algodClient, signTransactions, activeAddress, setStep,
      );
      toast.success(`mVote deployed — App ID ${appId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Deploy failed.";
      // A wallet rejection sends NOTHING, so the latch must come back off —
      // otherwise the button sits disabled under "a create was already
      // submitted", which is simply false and needs a reload to clear.
      if (/cancell?ed|rejected|denied/i.test(msg)) {
        setCreateSubmitted(false);
        writeLatch(activeAddress, false);
      }
      toast.error(msg);
    } finally {
      setStep(null);
      // Always re-scan. This is what turns a timed-out create from "lost" into
      // "listed below with a Finish setup button".
      await scan();
    }
  }

  const [pendingFounder, setPendingFounder] = useState("");
  const [busyFounder, setBusyFounder] = useState(false);

  async function handleNominate() {
    if (!activeAddress || !algodClient) return;
    setBusyFounder(true);
    try {
      await updateFounder(algodClient, signTransactions, activeAddress, pendingFounder);
      toast.success("Nominated. The incoming wallet must now accept.");
      setPendingFounder("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Nomination failed.");
    } finally {
      setBusyFounder(false);
    }
  }

  /** Finish a deploy whose second step did not land. Never creates a new app. */
  async function handleFinishSetup(appId: number) {
    if (!activeAddress || !algodClient) return;
    setStep("setup");
    try {
      await setupMVote(algodClient, signTransactions, activeAddress, appId);
      toast.success("Setup complete — the app is funded and opted in.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setStep(null);
      await scan();
    }
  }

  const copyId = (id: number) => {
    navigator.clipboard.writeText(String(id));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-magnet-300">
        <ShieldCheck className="h-4 w-4" /> Admin
      </div>

      {GOVERNANCE_LIVE ? (
        <Panel className="p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-white">Create a proposal</p>
              <p className="mt-0.5 text-xs text-gray-500">
                Post a direction question. Voting opens for 7 days · App {MVOTE.appId}
              </p>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-gradient-to-r from-magnet-600 to-magnet-500 px-4 py-2.5 text-sm font-semibold text-white hover:from-magnet-500 hover:to-magnet-400"
            >
              <PlusCircle className="h-4 w-4" /> New Proposal
            </button>
          </div>
        </Panel>
      ) : (
        <Panel className="p-5">
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-magnet-400" />
            <p className="text-sm font-semibold text-white">Deploy mVote ({GOVERNANCE_NETWORK})</p>
          </div>
          <p className="mt-2 text-xs text-gray-500 leading-relaxed">
            A two-step handshake you sign in your wallet: <span className="text-gray-300">(1)</span> create the
            contract (you become <span className="text-gray-300">founder</span>), then{" "}
            <span className="text-gray-300">(2)</span> fund it + opt into mUSD. The 0.4 ALGO covers the
            base minimum plus the asset opt-in. It no longer has to cover a standing vote-box buffer: the
            voter&apos;s MBR payment is the first transaction in the vote group, so it lands before the box
            that needs it.
          </p>

          {/*
            Driven by what the CHAIN says this wallet has created, not by what
            this component managed to hold on to. `found === null` means the
            scan failed or has not run — which is not "none", and must not put
            a Deploy button in front of someone who may already have an app.
          */}
          {found === null ? (
            // Fail closed — no Deploy button — but SAY so and offer a retry.
            // This state used to be indistinguishable from a slow load and had
            // no way out but a reload.
            <div className="mt-4 text-xs">
              {scanFailed ? (
                <p className="text-amber-200">
                  Couldn&apos;t check whether this wallet already deployed mVote, so the deploy
                  button is withheld rather than risk a duplicate.{" "}
                  <button onClick={() => void scan()} className="underline underline-offset-2 hover:text-amber-100">
                    Retry
                  </button>
                </p>
              ) : (
                <p className="text-gray-500">Checking for an existing deployment…</p>
              )}
            </div>
          ) : found.length > 0 ? (
            <div className="mt-4 space-y-3">
              {found.map(({ appId, optedIn, funded }) => {
                const ready = optedIn && funded;
                return (
                  <div key={appId} className={`rounded-xl border p-4 ${ready
                    ? "border-green-500/30 bg-green-500/5" : "border-amber-400/40 bg-amber-500/5"}`}>
                    <p className={`text-xs font-semibold uppercase tracking-widest ${ready
                      ? "text-green-400" : "text-amber-300"}`}>
                      {ready ? "Deployed" : "Created — setup unfinished"}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="font-mono text-lg font-bold text-white">App {appId}</span>
                      <button onClick={() => copyId(appId)} className="text-gray-500 hover:text-white">
                        {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                      </button>
                    </div>
                    {ready ? (
                      <p className="mt-2 text-xs text-gray-400 leading-relaxed">
                        Set <code className="text-magnet-300">MVOTE_APP_IDS.{GOVERNANCE_NETWORK} = {appId}</code> in{" "}
                        <code className="text-magnet-300">web/src/lib/governance.ts</code> and redeploy the site to go live.
                      </p>
                    ) : (
                      <>
                        <p className="mt-2 text-xs text-amber-200/90 leading-relaxed">
                          This app exists but is not {funded ? "" : "funded"}{!funded && !optedIn ? " or " : ""}
                          {optedIn ? "" : "opted into mUSD"}, so it cannot take votes yet. Finish setup signs
                          against <em>this</em> App ID and never creates another.
                        </p>
                        <button
                          onClick={() => void handleFinishSetup(appId)}
                          disabled={step !== null}
                          className="mt-3 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/15 disabled:opacity-40"
                        >
                          {step === "setup" ? "Signing…" : "Finish setup"}
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
              {found.length > 1 && (
                <p className="text-xs text-amber-200/80">
                  More than one mVote app was created by this wallet. Point the site at whichever
                  one you intend to use; the others are inert and hold no funds.
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4">
              <PrimaryButton
                onClick={handleDeploy}
                /*
                  `createSubmitted` latches the moment the first prompt goes
                  out, and is never cleared. A create that was submitted but
                  not confirmed leaves a real app on mainnet; re-enabling this
                  would make a second one a single click away, which is
                  exactly what happened before the scan existed.
                */
                disabled={!activeAddress || step !== null || createSubmitted}
              >
                {step === "create" && "Sign 1/2 — creating app…"}
                {step === "setup" && "Sign 2/2 — funding + opt-in…"}
                {step === null && (createSubmitted ? "Create submitted — rescanning…" : "Deploy mVote")}
              </PrimaryButton>
              {createSubmitted && (
                <p className="mt-2 text-xs text-amber-200/90">
                  A create was already submitted from this wallet. If it confirmed, it will appear
                  above on the next scan — reload rather than deploying again.
                </p>
              )}
            </div>
          )}
        </Panel>
      )}

      {/*
        Founder transfer, both halves.

        The contract has always supported this and the panel never exposed it,
        so rotating the protocol's governance key meant writing a script. Two
        steps on purpose: nothing changes until the incoming wallet accepts, so
        a typo'd address cannot strand the app — it just never gets accepted,
        and the current founder can overwrite the nomination.
      */}
      {GOVERNANCE_LIVE && (
        <Panel className="p-5">
          <p className="text-sm font-semibold text-white">Transfer founder</p>
          <p className="mt-0.5 text-xs text-gray-500">
            On chain now: <span className="font-mono">{founder ? `${founder.slice(0, 8)}…${founder.slice(-6)}` : "unknown"}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={pendingFounder}
              onChange={(e) => setPendingFounder(e.target.value.trim())}
              placeholder="New founder address"
              className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder-gray-600 focus:border-magnet-500 focus:outline-none"
            />
            <button
              onClick={handleNominate}
              disabled={pendingFounder.length !== 58 || busyFounder}
              className="rounded-lg border border-amber-400/40 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-500/15 disabled:opacity-40"
            >
              Nominate
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-600">
            Step 2 is signed by the <em>incoming</em> wallet. When it connects, an Accept
            banner appears for it above this panel — it cannot be done from here, because
            the nominee is not the founder until it accepts and this panel only renders
            for the founder. That gap made rotation impossible until it was found.
          </p>
        </Panel>
      )}

      {showCreate && (
        <CreateProposalModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => { setShowCreate(false); onProposalCreated(); }}
        />
      )}
    </div>
  );
}
