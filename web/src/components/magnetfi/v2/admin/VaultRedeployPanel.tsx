"use client";

import { useEffect, useMemo, useState } from "react";
import algosdk from "algosdk";
import { toast } from "sonner";
import { CheckCircle2, Circle, Loader2, Copy, Clock, AlertTriangle, RefreshCw } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { ACTIVE, VAULT_TYPES } from "@/lib/magnetfi";
import {
  makeAlgorand, deployVault, fundVault, configVault,
  proposeVaultRegistration, readVaultEta, confirmVaultRegistration,
} from "@/lib/magnetfiDeploy";
import { Panel } from "../shared";

// Focused, resumable flow to REDEPLOY the vault against the LIVE PSM + oracle (reusing the
// existing mUSD ASA). Distinct from the full-stack DeployWizard: it deploys ONLY a new vault
// and re-points the live PSM to it via the 48h timelock. Progress persists across the wait.
// v2: bumped from v1 so the completed progress persisted by the PRIOR redeploy (the repayment-fix
// vault) is ignored and this liquidation-penalty redeploy starts from a clean slate.
const LS_KEY = "magnetfi_vault_redeploy_v2";
const POOL = VAULT_TYPES.find((v) => v.status === "launching")!; // U/tALGO defaults

type State = {
  guardian: string;
  rateBps: string; ltvBps: string; liqThresholdBps: string;
  newVault?: string;
  done: Partial<Record<"deploy" | "fund" | "config" | "propose" | "confirm", boolean>>;
  etaTs?: number;
};

function freshState(): State {
  return {
    guardian: "",
    rateBps: String(POOL.rateBps), ltvBps: String(POOL.ltvBps), liqThresholdBps: String(POOL.liqThresholdBps),
    done: {},
  };
}

function load(): State {
  const base = freshState();
  if (typeof window === "undefined") return base;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...base, ...(JSON.parse(raw) as State) };
  } catch { /* ignore */ }
  return base;
}

export function VaultRedeployPanel() {
  const { address, algodClient, transactionSigner, network } = useWallet();
  const [s, setS] = useState<State>(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(s)); }, [s]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const algorand = useMemo(
    () => (algodClient && transactionSigner ? makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner]);

  const a = () => algorand!;
  const me = () => address!;
  const addrOk = (x: string) => !!x && algosdk.isValidAddress(x);
  const paramsOk =
    addrOk(s.guardian) && s.guardian !== address &&
    Number(s.rateBps) > 0 && Number(s.ltvBps) > 0 && Number(s.liqThresholdBps) > Number(s.ltvBps);

  const now = Math.floor(Date.now() / 1000);
  const etaReady = !!s.etaTs && now >= s.etaTs;
  const etaRemaining = s.etaTs ? Math.max(0, s.etaTs - now) : 0;

  async function run(id: string, fn: () => Promise<void>) {
    if (!algorand || !address) return;
    setBusy(id);
    try { await fn(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : "Transaction failed";
      toast.error(msg.includes("rejected") ? "Signing cancelled" : msg.slice(0, 140));
    } finally { setBusy(null); }
  }

  type Step = { id: string; label: string; desc: string; done: boolean; ready: boolean; action: () => Promise<void> };
  const d = s.done;
  const steps: Step[] = [
    {
      id: "deploy", label: "Deploy new vault", desc: `Wired to the LIVE PSM (${ACTIVE.psm}) + oracle (${ACTIVE.oracle}), reusing mUSD ${ACTIVE.musd}.`,
      done: !!s.newVault, ready: paramsOk && !s.newVault,
      action: async () => {
        const id = await deployVault(a(), me(), s.guardian, BigInt(ACTIVE.psm), BigInt(ACTIVE.oracle), ACTIVE.musd, ACTIVE.usdc);
        setS((x) => ({ ...x, newVault: id.toString(), done: { ...x.done, deploy: true } }));
        toast.success(`New vault deployed — app ${id}`);
      },
    },
    {
      id: "fund", label: "Fund new vault", desc: "Sends 1 ALGO for min-balance + opt-ins.",
      done: !!d.fund, ready: !!s.newVault && !d.fund,
      action: async () => {
        await fundVault(a(), me(), BigInt(s.newVault!));
        setS((x) => ({ ...x, done: { ...x.done, fund: true } }));
        toast.success("New vault funded");
      },
    },
    {
      id: "config", label: "Configure new vault", desc: `Opt into mUSD + LP (${ACTIVE.lpAsaId}); set rate / threshold / LTV / LP ASA.`,
      done: !!d.config, ready: !!s.newVault && !!d.fund && !d.config,
      action: async () => {
        await configVault(a(), me(), BigInt(s.newVault!), BigInt(ACTIVE.lpAsaId), BigInt(ACTIVE.poolId),
          BigInt(s.rateBps), BigInt(s.liqThresholdBps), BigInt(s.ltvBps), ACTIVE.musd);
        setS((x) => ({ ...x, done: { ...x.done, config: true } }));
        toast.success("New vault configured");
      },
    },
    {
      id: "propose", label: "Re-point PSM to new vault", desc: "Starts the 48-hour timelock. The OLD vault stays registered until you confirm.",
      done: !!d.propose, ready: !!s.newVault && !!d.config && !d.propose,
      action: async () => {
        await proposeVaultRegistration(a(), me(), BigInt(ACTIVE.psm), BigInt(s.newVault!));
        const eta = await readVaultEta(a(), BigInt(ACTIVE.psm), me());
        setS((x) => ({ ...x, done: { ...x.done, propose: true }, etaTs: eta }));
        toast.success("Re-point proposed — 48h timelock started");
      },
    },
  ];
  const confirmStep: Step = {
    id: "confirm", label: "Confirm re-point (after timelock)", desc: "Activates the new vault on the PSM; the old vault is deregistered.",
    done: !!d.confirm, ready: !!d.propose && etaReady && !d.confirm,
    action: async () => {
      await confirmVaultRegistration(a(), me(), BigInt(ACTIVE.psm));
      setS((x) => ({ ...x, done: { ...x.done, confirm: true } }));
      toast.success("New vault registered on PSM 🎉");
    },
  };

  function field(label: string, value: string, onChange: (v: string) => void, placeholder = "", hint?: string) {
    return (
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-400">{label}</label>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-magnet-500/50" />
        {hint && <p className="mt-1 text-[11px] text-gray-600">{hint}</p>}
      </div>
    );
  }

  function StepRow({ step, n }: { step: Step; n: number }) {
    return (
      <div className="flex items-center gap-4 border-b border-white/5 py-3 last:border-0">
        <div className="shrink-0">
          {step.done ? <CheckCircle2 className="h-5 w-5 text-green-400" />
            : busy === step.id ? <Loader2 className="h-5 w-5 animate-spin text-magnet-400" />
            : <Circle className={`h-5 w-5 ${step.ready ? "text-magnet-400" : "text-gray-700"}`} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${step.done ? "text-gray-400 line-through" : "text-white"}`}>{n}. {step.label}</p>
          <p className="text-xs text-gray-500">{step.desc}</p>
        </div>
        {!step.done && (
          <button onClick={() => run(step.id, step.action)} disabled={!step.ready || busy !== null}
            className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3.5 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30">Run</button>
        )}
      </div>
    );
  }

  const reset = () => {
    // Must clear to a FRESH state — the old reset() called load(), which re-read the same saved
    // progress and never actually cleared. removeItem + freshState guarantees a clean slate.
    if (confirm("Reset redeploy progress? (does not undo on-chain actions)")) {
      try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
      setS(freshState());
    }
  };

  return (
    <Panel className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Vault redeploy (reuse live PSM / oracle / mUSD)</p>
        <button onClick={reset} className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-white"><RefreshCw className="h-3 w-3" /> reset</button>
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <p className="text-xs leading-relaxed text-red-200/90">
          Redeploys ONLY the vault ({network}) and re-points the live PSM via the 48h timelock. Before starting,
          ensure no vaults are open and <strong>pause the current vault</strong> (Operations) so no loans open on the
          old contract during migration. This build has a larger global-state schema (12-pool capacity), so the{" "}
          <strong>admin wallet needs ~2.5 ALGO free</strong> to cover the create-time min-balance bump. After “Confirm”,
          paste the new vault ID into <code className="font-mono">DEPLOYMENTS.mainnet.vault</code> and redeploy the
          site — the new borrower repay flow requires this new vault.
        </p>
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        {field("Guardian address (cold, ≠ admin)", s.guardian, (v) => setS((x) => ({ ...x, guardian: v })), "ALGORAND ADDRESS", "Use the same guardian as the live deployment.")}
        {field("Interest rate (bps)", s.rateBps, (v) => setS((x) => ({ ...x, rateBps: v })))}
        {field("LTV (bps)", s.ltvBps, (v) => setS((x) => ({ ...x, ltvBps: v })))}
        {field("Liquidation threshold (bps)", s.liqThresholdBps, (v) => setS((x) => ({ ...x, liqThresholdBps: v })))}
      </div>
      {!paramsOk && <p className="mb-3 text-xs text-yellow-400/80">Enter a valid guardian (≠ admin) and ensure liquidation threshold &gt; LTV.</p>}

      {s.newVault && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm">
          <span className="text-gray-400">New vault app ID</span>
          <span className="flex items-center gap-2">
            <code className="font-mono text-magnet-200">{s.newVault}</code>
            <button onClick={() => { navigator.clipboard.writeText(s.newVault!); toast.success("Copied"); }} className="text-gray-500 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
          </span>
        </div>
      )}

      <div>{steps.map((step, i) => <StepRow key={step.id} step={step} n={i + 1} />)}</div>

      {d.propose && !d.confirm && (
        <div className="my-3 flex items-center gap-3 rounded-xl border border-magnet-500/20 bg-magnet-500/5 px-4 py-3">
          <Clock className="h-4 w-4 shrink-0 text-magnet-300" />
          <p className="text-xs text-magnet-200">
            {etaReady ? "Timelock elapsed — confirm the re-point below." :
              `Re-point timelock: ${Math.floor(etaRemaining / 3600)}h ${Math.floor((etaRemaining % 3600) / 60)}m remaining. You can close this page and come back.`}
          </p>
        </div>
      )}

      <div className="mt-1"><StepRow step={confirmStep} n={5} /></div>

      {d.confirm && (
        <p className="mt-4 text-xs text-green-300/90">
          Done on-chain. Next: set <code className="font-mono">DEPLOYMENTS.mainnet.vault = {s.newVault}</code> in{" "}
          <code className="font-mono">src/lib/magnetfi.ts</code>, redeploy the site, then unpause. Sweep any residual
          mUSD fees from the old vault with its <code className="font-mono">collect_fees</code>.
        </p>
      )}
    </Panel>
  );
}
