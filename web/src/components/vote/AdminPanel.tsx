"use client";

import { useState } from "react";
import { Rocket, PlusCircle, Copy, Check, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { Panel, PrimaryButton } from "@/components/magnetfi/v2/shared";
import { CreateProposalModal } from "@/components/vote/CreateProposalModal";
import { acceptFounder, deployMVote, setupMVote, updateFounder, type DeployStep } from "@/lib/governanceAdmin";
import { GOVERNANCE_LIVE, GOVERNANCE_NETWORK, MVOTE } from "@/lib/governance";

export function AdminPanel({ onProposalCreated, founder }: {
  onProposalCreated: () => void;
  /** The on-chain founder, or null if not deployed / unreadable. */
  founder?: string | null;
}) {
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [showCreate, setShowCreate] = useState(false);

  // deploy handshake state
  const [step, setStep] = useState<DeployStep | null>(null);
  const [deployedId, setDeployedId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  /** Set the moment step 1 confirms, so a failed step 2 cannot lose the App ID. */
  const [needsSetup, setNeedsSetup] = useState(false);

  async function handleDeploy() {
    if (!activeAddress || !algodClient) return;
    try {
      const { appId } = await deployMVote(
        algodClient, signTransactions, activeAddress, setStep,
        // Captured BEFORE step 2 is attempted. Step 1 creates a real app on
        // mainnet; if the second prompt is rejected, this id is the only way
        // back to it short of trawling the indexer.
        (id) => { setDeployedId(id); setNeedsSetup(true); },
      );
      setNeedsSetup(false);
      toast.success(`mVote deployed — App ID ${appId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Deploy failed.");
    } finally {
      setStep(null);
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

  async function handleAccept() {
    if (!activeAddress || !algodClient) return;
    setBusyFounder(true);
    try {
      await acceptFounder(algodClient, signTransactions, activeAddress);
      toast.success("Founder accepted. Reload to pick up the new authority.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Accept failed.");
    } finally {
      setBusyFounder(false);
    }
  }

  /** Finish a deploy whose second step did not land. Never creates a new app. */
  async function handleFinishSetup() {
    if (!activeAddress || !algodClient || !deployedId) return;
    setStep("setup");
    try {
      await setupMVote(algodClient, signTransactions, activeAddress, deployedId);
      setNeedsSetup(false);
      toast.success("Setup complete — the app is funded and opted in.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setStep(null);
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

          {deployedId ? (
            <div className={`mt-4 rounded-xl border p-4 ${needsSetup
              ? "border-amber-400/40 bg-amber-500/5" : "border-green-500/30 bg-green-500/5"}`}>
              <p className={`text-xs font-semibold uppercase tracking-widest ${needsSetup
                ? "text-amber-300" : "text-green-400"}`}>
                {needsSetup ? "Created — setup unfinished" : "Deployed"}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-lg font-bold text-white">App {deployedId}</span>
                <button onClick={() => copyId(deployedId)} className="text-gray-500 hover:text-white">
                  {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              {needsSetup ? (
                <>
                  <p className="mt-2 text-xs text-amber-200/90 leading-relaxed">
                    The app exists but is not funded or opted into mUSD, so it cannot take votes yet.
                    Finish setup — this signs against <em>this</em> App ID and never creates another.
                  </p>
                  <button
                    onClick={handleFinishSetup}
                    disabled={step !== null}
                    className="mt-3 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/15 disabled:opacity-40"
                  >
                    {step === "setup" ? "Signing…" : "Finish setup"}
                  </button>
                </>
              ) : (
                <p className="mt-2 text-xs text-gray-400 leading-relaxed">
                  Set <code className="text-magnet-300">MVOTE_APP_IDS.{GOVERNANCE_NETWORK} = {deployedId}</code> in{" "}
                  <code className="text-magnet-300">web/src/lib/governance.ts</code> and redeploy the site to go live.
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4">
              <PrimaryButton onClick={handleDeploy} disabled={!activeAddress || step !== null}>
                {step === "create" && "Sign 1/2 — creating app…"}
                {step === "setup" && "Sign 2/2 — funding + opt-in…"}
                {step === null && "Deploy mVote"}
              </PrimaryButton>
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
            Step 2 is signed by the <em>incoming</em> wallet. Connect it and press Accept.
          </p>
          <button
            onClick={handleAccept}
            disabled={busyFounder}
            className="mt-2 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:text-white disabled:opacity-40"
          >
            Accept founder (as the incoming wallet)
          </button>
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
