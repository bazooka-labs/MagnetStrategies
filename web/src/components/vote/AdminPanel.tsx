"use client";

import { useState } from "react";
import { Rocket, PlusCircle, Copy, Check, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { Panel, PrimaryButton } from "@/components/magnetfi/v2/shared";
import { CreateProposalModal } from "@/components/vote/CreateProposalModal";
import { deployMVote, type DeployStep } from "@/lib/governanceAdmin";
import { GOVERNANCE_LIVE, GOVERNANCE_NETWORK, MVOTE } from "@/lib/governance";

export function AdminPanel({ onProposalCreated }: { onProposalCreated: () => void }) {
  const { activeAddress, signTransactions, algodClient } = useWallet();
  const [showCreate, setShowCreate] = useState(false);

  // deploy handshake state
  const [step, setStep] = useState<DeployStep | null>(null);
  const [deployedId, setDeployedId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleDeploy() {
    if (!activeAddress || !algodClient) return;
    try {
      const { appId } = await deployMVote(algodClient, signTransactions, activeAddress, setStep);
      setDeployedId(appId);
      toast.success(`mVote deployed — App ID ${appId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Deploy failed.");
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
            <span className="text-gray-300">(2)</span> fund it + opt into mUSD. The app is funded with a
            standing buffer so the first vote always lands — the vote box is created at group index 0 but the
            voter&apos;s MBR payment settles at index 2, so without it the FIRST vote fails its own
            min-balance check.
          </p>

          {deployedId ? (
            <div className="mt-4 rounded-xl border border-green-500/30 bg-green-500/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-green-400">Deployed</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-lg font-bold text-white">App {deployedId}</span>
                <button onClick={() => copyId(deployedId)} className="text-gray-500 hover:text-white">
                  {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-400 leading-relaxed">
                Set <code className="text-magnet-300">MVOTE_APP_IDS.{GOVERNANCE_NETWORK} = {deployedId}</code> in{" "}
                <code className="text-magnet-300">web/src/lib/governance.ts</code> and redeploy the site to go live.
              </p>
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

      {showCreate && (
        <CreateProposalModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => { setShowCreate(false); onProposalCreated(); }}
        />
      )}
    </div>
  );
}
