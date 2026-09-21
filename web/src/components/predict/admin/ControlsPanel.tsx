"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Pause, Play, AlertTriangle } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel } from "@/components/magnetfi/v2/shared";
import {
  adminVoidRound, cleanupRound, makeAlgorand, setBandBounds, setParam, setPaused,
  sweepExcessMusd, sweepRake, voidRound, withdrawOperatingAlgo,
} from "@/lib/vplOps";
import { DEFAULT_BAND_BOUNDS, MUSD_ASA_ID_MAINNET, VPL_APP_ID } from "@/lib/vpl";

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-white/5 py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="mt-0.5 text-xs text-gray-500">{desc}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

const inputCls =
  "w-32 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-xs text-white outline-none focus:border-magnet-500/50";
const btnCls =
  "rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30";

export function ControlsPanel({ paused, onDone }: { paused: boolean; onDone: () => void }) {
  const { address, algodClient, transactionSigner } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [rake, setRake] = useState("400");
  const [minStake, setMinStake] = useState("5");
  const [bounds, setBounds] = useState(DEFAULT_BAND_BOUNDS.join(", "));
  const [roundId, setRoundId] = useState("");
  const [sweepAmt, setSweepAmt] = useState("");
  const [algoAmt, setAlgoAmt] = useState("");

  const a = () => makeAlgorand(algodClient!, transactionSigner!);
  const me = () => address!;
  const app = () => BigInt(VPL_APP_ID);

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    try { await fn(); toast.success(ok); onDone(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const B = ({ id, onClick, children, danger = false }: {
    id: string; onClick: () => void; children: React.ReactNode; danger?: boolean;
  }) => (
    <button onClick={onClick} disabled={busy !== null}
      className={danger
        ? "rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 disabled:opacity-30"
        : btnCls}>
      {busy === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );

  return (
    <div className="space-y-6">
      {/* Emergency stop */}
      <Panel className="p-6">
        <p className="mb-1 text-sm font-semibold text-white">Emergency stop</p>
        <p className="mb-4 text-xs text-gray-500">
          Blocks new rounds and new entries immediately. Read live, never snapshotted — so it works on a
          round already underway. Every exit path ignores it, so funds in flight are never trapped.
        </p>
        <button
          onClick={() => run("pause", () => setPaused(a(), me(), app(), !paused),
            paused ? "Unpaused" : "Paused — entries blocked")}
          disabled={busy !== null}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40 ${
            paused
              ? "bg-gradient-to-r from-green-600 to-green-500 text-white"
              : "border border-red-500/40 bg-red-500/10 text-red-200"}`}
        >
          {busy === "pause" ? <Loader2 className="h-4 w-4 animate-spin" />
            : paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {paused ? "Resume" : "Pause entries"}
        </button>
      </Panel>

      {/* Round recovery */}
      <Panel className="p-6">
        <p className="mb-1 text-sm font-semibold text-white">Round recovery</p>
        <p className="mb-2 text-xs text-gray-500">
          For when the keeper misses a checkpoint. <code className="font-mono">void_round</code> is
          permissionless — anyone can call it once the deadline passes.
        </p>
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500/70" />
          <p className="text-[11px] leading-relaxed text-gray-400">
            Admin void is OPEN-only and refunds everyone in full with no rake. It is informationally
            neutral because no reference price exists before lock — nobody is expropriated.
          </p>
        </div>
        <input value={roundId} onChange={(e) => setRoundId(e.target.value)} placeholder="round id"
          className={`${inputCls} mb-3`} />
        <div className="flex flex-wrap gap-2">
          <B id="void" onClick={() => run("void", () => voidRound(a(), me(), app(), Number(roundId)), "Round voided")}>
            Void (past deadline)
          </B>
          <B id="adminvoid" danger
            onClick={() => run("adminvoid", () => adminVoidRound(a(), me(), app(), Number(roundId)), "Round voided, full refunds")}>
            Admin void (OPEN only)
          </B>
          <B id="cleanup" onClick={() => run("cleanup", () => cleanupRound(a(), me(), app(), Number(roundId)), "Round cleaned up")}>
            Cleanup
          </B>
        </div>
      </Panel>

      {/* Parameters */}
      <Panel className="p-6">
        <p className="mb-1 text-sm font-semibold text-white">Parameters</p>
        <p className="mb-2 text-xs text-gray-500">
          Snapshotted into each round at creation, so a change never alters the terms of a round
          already underway.
        </p>
        <Row title="Rake" desc="Basis points. Hard-capped at 1000 (10%) by the contract.">
          <input value={rake} onChange={(e) => setRake(e.target.value)} className={inputCls} />
          <B id="rake" onClick={() => run("rake", () => setParam(a(), me(), app(), "set_default_rake_bps", Number(rake)), "Rake updated")}>Set</B>
        </Row>
        <Row title="Minimum stake" desc="mUSD. Ordinary parameter hygiene, not a throttle on anything.">
          <input value={minStake} onChange={(e) => setMinStake(e.target.value)} className={inputCls} />
          <B id="minstake" onClick={() => run("minstake", () => setParam(a(), me(), app(), "set_min_stake", Math.round(Number(minStake) * 1e6)), "Minimum stake updated")}>Set</B>
        </Row>
        <Row title="Band bounds"
          desc="Eight bps multipliers, strictly increasing, straddling 10000. Each band capped at 1000 bps wide.">
          <input value={bounds} onChange={(e) => setBounds(e.target.value)} className={`${inputCls} w-72`} />
          <B id="bounds" onClick={() => run("bounds",
            () => setBandBounds(a(), me(), app(), bounds.split(",").map((x) => Number(x.trim()))), "Band bounds updated")}>Set</B>
        </Row>
      </Panel>

      {/* Treasury */}
      <Panel className="p-6">
        <p className="mb-1 text-sm font-semibold text-white">Treasury</p>
        <p className="mb-2 text-xs text-gray-500">
          Rake accrues to a counter and is swept separately, so settlement can never fail because of
          treasury state. Sweeping is permissionless — anyone can trigger it.
        </p>
        <Row title="Sweep rake" desc="Moves accrued rake to the treasury address.">
          <B id="rakeSweep" onClick={() => run("rakeSweep",
            () => sweepRake(a(), me(), app(), BigInt(MUSD_ASA_ID_MAINNET), me()), "Rake swept")}>Sweep</B>
        </Row>
        <Row title="Recover stray mUSD"
          desc="mUSD sent directly to the app. Bounded by obligations, so it can never touch live escrow.">
          <input value={sweepAmt} onChange={(e) => setSweepAmt(e.target.value)} placeholder="mUSD" className={inputCls} />
          <B id="excess" onClick={() => run("excess",
            () => sweepExcessMusd(a(), me(), app(), BigInt(Math.round(Number(sweepAmt) * 1e6)), BigInt(MUSD_ASA_ID_MAINNET), me()), "Recovered")}>Sweep</B>
        </Row>
        <Row title="Withdraw operating ALGO"
          desc="Floored to reserve box deposits, payout fees and round-box headroom.">
          <input value={algoAmt} onChange={(e) => setAlgoAmt(e.target.value)} placeholder="ALGO" className={inputCls} />
          <B id="algo" onClick={() => run("algo",
            () => withdrawOperatingAlgo(a(), me(), app(), BigInt(Math.round(Number(algoAmt) * 1e6))), "Withdrawn")}>Withdraw</B>
        </Row>
      </Panel>
    </div>
  );
}
