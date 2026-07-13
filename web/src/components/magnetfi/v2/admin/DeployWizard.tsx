"use client";

import { useEffect, useMemo, useState } from "react";
import algosdk from "algosdk";
import { toast } from "sonner";
import { CheckCircle2, Circle, Loader2, Copy, Clock, AlertTriangle } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import {
  makeAlgorand,
  deployOracle, deployPsm, deployVault, fundApps,
  configOracle, configPsm, configVault,
  proposeVaultRegistration, readVaultEta, confirmVaultRegistration,
  seedReserve, openCeiling,
} from "@/lib/magnetfiDeploy";
import { Panel } from "../shared";

const LS_KEY = "magnetfi_deploy_v1";

type Inputs = {
  guardian: string; bot: string; treasury: string;
  musdAsaId: string; usdcAsaId: string; lpAsaId: string;
  poolId: string; initialPrice: string;
  rateBps: string; ltvBps: string; liqThresholdBps: string; usdcDeposit: string;
};
type Ids = { oracle?: string; psm?: string; vault?: string };
type Done = Partial<Record<"fund" | "oracle" | "psm" | "vault" | "propose" | "confirm" | "seed" | "ceiling", boolean>>;
type State = { inputs: Inputs; ids: Ids; done: Done; etaTs?: number };

const DEFAULTS: Inputs = {
  guardian: "", bot: "", treasury: "",
  musdAsaId: "3615600399", usdcAsaId: "31566704", lpAsaId: "",
  poolId: "", initialPrice: "",
  rateBps: "800", ltvBps: "6000", liqThresholdBps: "7500", usdcDeposit: "",
};

function load(): State {
  if (typeof window === "undefined") return { inputs: DEFAULTS, ids: {}, done: {} };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch { /* ignore */ }
  return { inputs: DEFAULTS, ids: {}, done: {} };
}

function field(label: string, value: string, onChange: (v: string) => void, placeholder = "", hint?: string) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-400">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-magnet-500/50"
      />
      {hint && <p className="mt-1 text-[11px] text-gray-600">{hint}</p>}
    </div>
  );
}

export function DeployWizard() {
  const { address, algodClient, transactionSigner, network } = useWallet();
  const [state, setState] = useState<State>(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const algorand = useMemo(() => {
    if (!algodClient || !transactionSigner) return null;
    return makeAlgorand(algodClient, transactionSigner);
  }, [algodClient, transactionSigner]);

  const { inputs, ids, done } = state;
  const setInput = (k: keyof Inputs, v: string) =>
    setState((s) => ({ ...s, inputs: { ...s.inputs, [k]: v } }));

  const addrOk = (a: string) => !!a && algosdk.isValidAddress(a);
  const poolId = () => BigInt(inputs.poolId || inputs.lpAsaId || "0");
  const priceScaled = () => BigInt(Math.round((Number(inputs.initialPrice) || 0) * 1_000_000));
  const usdcBase = () => BigInt(Math.round((Number(inputs.usdcDeposit) || 0) * 1_000_000));
  const musd = () => Number(inputs.musdAsaId);
  const usdc = () => Number(inputs.usdcAsaId);

  const inputsValid =
    addrOk(inputs.guardian) && addrOk(inputs.bot) && addrOk(inputs.treasury) &&
    inputs.guardian !== address &&
    musd() > 0 && usdc() > 0 && Number(inputs.lpAsaId) > 0 && Number(inputs.initialPrice) > 0 &&
    Number(inputs.rateBps) > 0 && Number(inputs.liqThresholdBps) > Number(inputs.ltvBps) &&
    Number(inputs.ltvBps) > 0;

  const now = Math.floor(Date.now() / 1000);
  const etaReady = !!state.etaTs && now >= state.etaTs;
  const etaRemaining = state.etaTs ? Math.max(0, state.etaTs - now) : 0;
  const isMainnet = network === "mainnet";

  async function run(id: string, fn: () => Promise<void>) {
    if (!algorand || !address) return;
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transaction failed";
      toast.error(msg.includes("rejected") ? "Signing cancelled" : msg.slice(0, 140));
      throw e;
    } finally {
      setBusy(null);
    }
  }

  const a = () => algorand!;
  const me = () => address!;

  type Step = { id: string; label: string; desc: string; done: boolean; ready: boolean; action: () => Promise<void> };

  const steps: Step[] = [
    {
      id: "deploy_oracle", label: "Deploy LP Oracle", desc: "Creates the oracle with the guardian.",
      done: !!ids.oracle, ready: inputsValid && !ids.oracle,
      action: async () => {
        const id = await deployOracle(a(), me(), inputs.guardian);
        setState((s) => ({ ...s, ids: { ...s.ids, oracle: id.toString() } }));
        toast.success(`Oracle deployed — app ${id}`);
      },
    },
    {
      id: "deploy_psm", label: "Deploy PSM (v3 — Productive Reserves)", desc: "Creates the yield-bearing PSM with mUSD, USDC, and the guardian. Whitelist a yield adapter later from the Productive Reserves panel.",
      done: !!ids.psm, ready: inputsValid && !ids.psm,
      action: async () => {
        const id = await deployPsm(a(), me(), inputs.guardian, musd(), usdc());
        setState((s) => ({ ...s, ids: { ...s.ids, psm: id.toString() } }));
        toast.success(`PSM deployed — app ${id}`);
      },
    },
    {
      id: "deploy_vault", label: "Deploy Vault", desc: "Creates the vault, wired to the PSM + oracle.",
      done: !!ids.vault, ready: inputsValid && !!ids.psm && !!ids.oracle && !ids.vault,
      action: async () => {
        const id = await deployVault(a(), me(), inputs.guardian, BigInt(ids.psm!), BigInt(ids.oracle!), musd(), usdc());
        setState((s) => ({ ...s, ids: { ...s.ids, vault: id.toString() } }));
        toast.success(`Vault deployed — app ${id}`);
      },
    },
    {
      id: "fund", label: "Fund app accounts", desc: "Sends ALGO to the three apps for min-balance + opt-ins.",
      done: !!done.fund, ready: !!ids.oracle && !!ids.psm && !!ids.vault && !done.fund,
      action: async () => {
        await fundApps(a(), me(), { oracle: BigInt(ids.oracle!), psm: BigInt(ids.psm!), vault: BigInt(ids.vault!) });
        setState((s) => ({ ...s, done: { ...s.done, fund: true } }));
        toast.success("App accounts funded");
      },
    },
    {
      id: "oracle", label: "Configure oracle", desc: "Authorize the bot + register the pool (price + ±25% anchor).",
      done: !!done.oracle, ready: !!ids.oracle && !!done.fund && !done.oracle,
      action: async () => {
        await configOracle(a(), me(), BigInt(ids.oracle!), inputs.bot, poolId(), priceScaled());
        setState((s) => ({ ...s, done: { ...s.done, oracle: true } }));
        toast.success("Oracle configured");
      },
    },
    {
      id: "psm", label: "Configure PSM", desc: "Opt into mUSD + USDC and set the treasury.",
      done: !!done.psm, ready: !!ids.psm && !!done.fund && !done.psm,
      action: async () => {
        await configPsm(a(), me(), BigInt(ids.psm!), inputs.treasury, musd(), usdc());
        setState((s) => ({ ...s, done: { ...s.done, psm: true } }));
        toast.success("PSM configured");
      },
    },
    {
      id: "vault", label: "Configure vault", desc: "Opt into mUSD + LP and set rate / threshold / LTV / LP ASA.",
      done: !!done.vault, ready: !!ids.vault && !!done.fund && !done.vault,
      action: async () => {
        await configVault(a(), me(), BigInt(ids.vault!), BigInt(inputs.lpAsaId), poolId(),
          BigInt(inputs.rateBps), BigInt(inputs.liqThresholdBps), BigInt(inputs.ltvBps), musd());
        setState((s) => ({ ...s, done: { ...s.done, vault: true } }));
        toast.success("Vault configured");
      },
    },
    {
      id: "propose", label: "Register vault on PSM", desc: "Starts the 48-hour timelock before it takes effect.",
      done: !!done.propose, ready: !!ids.psm && !!ids.vault && !!done.psm && !!done.vault && !done.propose,
      action: async () => {
        await proposeVaultRegistration(a(), me(), BigInt(ids.psm!), BigInt(ids.vault!));
        const eta = await readVaultEta(a(), BigInt(ids.psm!), me());
        setState((s) => ({ ...s, done: { ...s.done, propose: true }, etaTs: eta }));
        toast.success("Vault registration proposed — 48h timelock started");
      },
    },
  ];

  const phase2: Step[] = [
    {
      id: "confirm", label: "Confirm vault registration", desc: "Activates the vault on the PSM after the timelock.",
      done: !!done.confirm, ready: !!done.propose && etaReady && !done.confirm,
      action: async () => {
        await confirmVaultRegistration(a(), me(), BigInt(ids.psm!));
        setState((s) => ({ ...s, done: { ...s.done, confirm: true } }));
        toast.success("Vault registered on PSM");
      },
    },
    {
      id: "seed", label: "Seed mUSD reserve", desc: "Transfer the full 500M mUSD supply into the PSM.",
      done: !!done.seed, ready: !!done.confirm && !done.seed,
      action: async () => {
        await seedReserve(a(), me(), BigInt(ids.psm!), musd());
        setState((s) => ({ ...s, done: { ...s.done, seed: true } }));
        toast.success("Reserve seeded");
      },
    },
    {
      id: "ceiling", label: "Open vault ceiling", desc: "Deposit initial USDC to open borrowing capacity.",
      done: !!done.ceiling, ready: !!done.seed && Number(inputs.usdcDeposit) > 0 && !done.ceiling,
      action: async () => {
        await openCeiling(a(), me(), BigInt(ids.psm!), usdcBase(), usdc());
        setState((s) => ({ ...s, done: { ...s.done, ceiling: true } }));
        toast.success("Ceiling opened — deploy complete 🎉");
      },
    },
  ];

  function StepRow({ s, n }: { s: Step; n: number }) {
    return (
      <div className="flex items-center gap-4 border-b border-white/5 py-3 last:border-0">
        <div className="shrink-0">
          {s.done ? (
            <CheckCircle2 className="h-5 w-5 text-green-400" />
          ) : busy === s.id ? (
            <Loader2 className="h-5 w-5 animate-spin text-magnet-400" />
          ) : (
            <Circle className={`h-5 w-5 ${s.ready ? "text-magnet-400" : "text-gray-700"}`} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${s.done ? "text-gray-400 line-through" : "text-white"}`}>
            {n}. {s.label}
          </p>
          <p className="text-xs text-gray-500">{s.desc}</p>
        </div>
        {!s.done && (
          <button
            onClick={() => run(s.id, s.action)}
            disabled={!s.ready || busy !== null}
            className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3.5 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            Run
          </button>
        )}
      </div>
    );
  }

  const idRow = (label: string, v?: string) =>
    v ? (
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-gray-400">{label}</span>
        <span className="flex items-center gap-2">
          <code className="font-mono text-magnet-200">{v}</code>
          <button onClick={() => { navigator.clipboard.writeText(v); toast.success("Copied"); }}
            className="text-gray-500 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
        </span>
      </div>
    ) : null;

  return (
    <div className="space-y-6">
      {/* Network + safety banner */}
      <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 ${
        isMainnet ? "border-red-500/30 bg-red-500/5" : "border-blue-500/30 bg-blue-500/5"
      }`}>
        <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${isMainnet ? "text-red-400" : "text-blue-400"}`} />
        <p className={`text-xs leading-relaxed ${isMainnet ? "text-red-200/90" : "text-blue-200/90"}`}>
          Active network: <strong>{network}</strong>.{" "}
          {isMainnet
            ? "This deploys REAL mainnet contracts that custody funds. Rehearse the full flow on testnet first."
            : "Testnet rehearsal mode. Create stand-in assets below and enter their IDs before running."}{" "}
          Progress is saved in this browser — you can close and resume, including across the 48-hour timelock.
        </p>
      </div>

      {/* Inputs */}
      <Panel className="p-6">
        <p className="mb-4 text-sm font-semibold text-white">Deployment parameters</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {field("Guardian address (cold, ≠ admin)", inputs.guardian, (v) => setInput("guardian", v), "ALGORAND ADDRESS")}
          {field("Oracle bot address", inputs.bot, (v) => setInput("bot", v), "ALGORAND ADDRESS")}
          {field("Treasury address", inputs.treasury, (v) => setInput("treasury", v), "ALGORAND ADDRESS")}
          {field("mUSD ASA ID", inputs.musdAsaId, (v) => setInput("musdAsaId", v), "", isMainnet ? "Mainnet mUSD." : "Use your testnet mUSD ID.")}
          {field("USDC ASA ID", inputs.usdcAsaId, (v) => setInput("usdcAsaId", v), "", isMainnet ? "Mainnet USDC." : "Use your mock-USDC ID.")}
          {field("LP token ASA ID", inputs.lpAsaId, (v) => setInput("lpAsaId", v), "e.g. 123456789")}
          {field("Pool ID", inputs.poolId, (v) => setInput("poolId", v), "defaults to the LP ASA ID", "Arbitrary key; leave blank to use the LP ASA ID.")}
          {field("Initial LP price (mUSD per LP)", inputs.initialPrice, (v) => setInput("initialPrice", v), "e.g. 2.50", "Stored as price ×1e6 and the ±25% anchor.")}
          {field("Interest rate (bps)", inputs.rateBps, (v) => setInput("rateBps", v))}
          {field("LTV (bps)", inputs.ltvBps, (v) => setInput("ltvBps", v))}
          {field("Liquidation threshold (bps)", inputs.liqThresholdBps, (v) => setInput("liqThresholdBps", v))}
          {field("Initial USDC deposit", inputs.usdcDeposit, (v) => setInput("usdcDeposit", v), "e.g. 100000", "Opens the vault ceiling.")}
        </div>
        {!inputsValid && (
          <p className="mt-3 text-xs text-yellow-400/80">
            Fill all addresses (guardian must differ from the admin) and asset IDs, and ensure liquidation threshold &gt; LTV.
          </p>
        )}
      </Panel>

      {/* Deployed IDs */}
      {(ids.oracle || ids.psm || ids.vault) && (
        <Panel className="p-6">
          <p className="mb-3 text-sm font-semibold text-white">Deployed app IDs</p>
          <div className="space-y-1.5">
            {idRow("LP Oracle", ids.oracle)}
            {idRow("PSM", ids.psm)}
            {idRow("Vault", ids.vault)}
          </div>
          <p className="mt-3 text-xs text-gray-500">
            For a mainnet deploy, paste these into <code className="font-mono">src/lib/magnetfi.ts</code> (`MAGNETFI_APPS`)
            and the oracle bot config.
          </p>
        </Panel>
      )}

      {/* Phase 1 */}
      <Panel className="p-6">
        <p className="mb-2 text-sm font-semibold text-white">Phase 1 — Deploy &amp; configure</p>
        <div>{steps.map((s, i) => <StepRow key={s.id} s={s} n={i + 1} />)}</div>
      </Panel>

      {/* Timelock wait */}
      {done.propose && !done.confirm && (
        <div className="flex items-center gap-3 rounded-xl border border-magnet-500/20 bg-magnet-500/5 px-4 py-3">
          <Clock className="h-4 w-4 shrink-0 text-magnet-300" />
          <p className="text-xs text-magnet-200">
            {etaReady
              ? "Timelock elapsed — you can confirm the vault registration below."
              : `Vault-registration timelock: ${Math.floor(etaRemaining / 3600)}h ${Math.floor((etaRemaining % 3600) / 60)}m remaining. You can close this page and come back.`}
          </p>
        </div>
      )}

      {/* Phase 2 */}
      <Panel className="p-6">
        <p className="mb-2 text-sm font-semibold text-white">Phase 2 — Finalize (after timelock)</p>
        <div>{phase2.map((s, i) => <StepRow key={s.id} s={s} n={i + 9} />)}</div>
      </Panel>
    </div>
  );
}
