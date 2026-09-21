"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Circle, Loader2, Copy, AlertTriangle } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel } from "@/components/magnetfi/v2/shared";
import {
  APP_FUND_AMOUNT, APP_MIN_BALANCE, bootstrap, createApp, fundApp, makeAlgorand,
} from "@/lib/vplOps";
import { MUSD_ASA_ID_MAINNET } from "@/lib/vpl";

const LS_KEY = "vpl_deploy_v1";

type Inputs = { musdAsaId: string; treasury: string; keeper: string; oraclePubkey: string };
type State = { inputs: Inputs; appId?: string; appAddress?: string; done: Partial<Record<"fund" | "bootstrap", boolean>> };

const DEFAULTS: Inputs = { musdAsaId: String(MUSD_ASA_ID_MAINNET), treasury: "", keeper: "", oraclePubkey: "" };

function load(): State {
  if (typeof window === "undefined") return { inputs: DEFAULTS, done: {} };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch { /* ignore */ }
  return { inputs: DEFAULTS, done: {} };
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

export function DeployPanel() {
  const { address, algodClient, transactionSigner, network } = useWallet();
  const [state, setState] = useState<State>(load);
  const [busy, setBusy] = useState<string | null>(null);
  const isMainnet = network === "mainnet";

  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(state)); }, [state]);

  const { inputs, appId, appAddress, done } = state;
  const setInput = (k: keyof Inputs, v: string) =>
    setState((s) => ({ ...s, inputs: { ...s.inputs, [k]: v } }));

  const a = () => makeAlgorand(algodClient!, transactionSigner!);
  const me = () => address!;

  const pubkeyBytes = (() => {
    const hex = inputs.oraclePubkey.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
    return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  })();

  const inputsValid =
    !!inputs.musdAsaId && !!inputs.treasury && !!inputs.keeper && !!pubkeyBytes;

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    try { await fn(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const steps = [
    {
      id: "create",
      label: "Create application",
      desc: "Deploys the contract with 2 extra program pages. You become admin.",
      done: !!appId,
      ready: inputsValid && !appId,
      action: async () => {
        const r = await createApp(a(), me(), BigInt(inputs.musdAsaId));
        setState((s) => ({ ...s, appId: String(r.appId), appAddress: r.appAddress }));
        toast.success(`Created app ${r.appId}`);
      },
    },
    {
      id: "fund",
      label: "Fund the app account",
      desc: `Sends ${APP_FUND_AMOUNT / 1e6} ALGO — minimum balance, round boxes, operating float.`,
      done: !!done.fund,
      ready: !!appId && !done.fund,
      action: async () => {
        await fundApp(a(), me(), appAddress!);
        setState((s) => ({ ...s, done: { ...s.done, fund: true } }));
        toast.success("App account funded");
      },
    },
    {
      id: "bootstrap",
      label: "Bootstrap",
      desc: "Sets the asset, oracle key, keeper, treasury, rake and bands. One-shot.",
      done: !!done.bootstrap,
      ready: !!appId && !!done.fund && !done.bootstrap,
      action: async () => {
        await bootstrap(a(), me(), BigInt(appId!), {
          musdAsaId: BigInt(inputs.musdAsaId),
          treasury: inputs.treasury,
          keeper: inputs.keeper,
          oraclePubkey: pubkeyBytes!,
        });
        setState((s) => ({ ...s, done: { ...s.done, bootstrap: true } }));
        toast.success("Bootstrapped — deployment complete");
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 ${
        isMainnet ? "border-red-500/30 bg-red-500/5" : "border-blue-500/30 bg-blue-500/5"}`}>
        <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${isMainnet ? "text-red-400" : "text-blue-400"}`} />
        <p className={`text-xs leading-relaxed ${isMainnet ? "text-red-200/90" : "text-blue-200/90"}`}>
          Active network: <strong>{network}</strong>.{" "}
          {isMainnet
            ? "Bootstrap is one-shot and irreversible, and this contract can never be upgraded or deleted. A wrong asset ID means abandoning the deployment and permanently stranding its ~1.13 ALGO minimum balance."
            : "Rehearsal mode."}{" "}
          Progress is saved in this browser — you can close this page and resume.
        </p>
      </div>

      <Panel className="p-6">
        <p className="mb-4 text-sm font-semibold text-white">Deployment parameters</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {field("mUSD ASA ID", inputs.musdAsaId, (v) => setInput("musdAsaId", v), "",
            isMainnet ? "Mainnet mUSD. Baked into the program at deploy." : "Your stand-in asset ID.")}
          {field("Treasury address", inputs.treasury, (v) => setInput("treasury", v), "ALGORAND ADDRESS",
            "Receives rake. Must opt into mUSD before the first sweep.")}
          {field("Keeper address", inputs.keeper, (v) => setInput("keeper", v), "ALGORAND ADDRESS",
            "Hot wallet on the keeper host. Barred from entering rounds.")}
          {field("Oracle public key (hex)", inputs.oraclePubkey, (v) => setInput("oraclePubkey", v),
            "64 hex characters",
            "From `python -m vplkeeper.config genkey`. The PUBLIC half only.")}
        </div>
        {!inputsValid && (
          <p className="mt-3 text-xs text-yellow-400/80">
            Fill every field. The oracle key must be exactly 64 hex characters (32 bytes).
          </p>
        )}
      </Panel>

      {appId && (
        <Panel className="p-6">
          <p className="mb-3 text-sm font-semibold text-white">Deployed</p>
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-400">App ID</span>
              <span className="flex items-center gap-2">
                <code className="font-mono text-magnet-200">{appId}</code>
                <button onClick={() => { navigator.clipboard.writeText(appId); toast.success("Copied"); }}
                  className="text-gray-500 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-400">App address</span>
              <code className="truncate font-mono text-xs text-magnet-200">{appAddress}</code>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            Set <code className="font-mono">NEXT_PUBLIC_VPL_APP_ID={appId}</code> and export the same value
            for the keeper as <code className="font-mono">VPL_APP_ID</code>.
          </p>
        </Panel>
      )}

      <Panel className="p-6">
        <p className="mb-2 text-sm font-semibold text-white">Steps</p>
        {steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-4 border-b border-white/5 py-3 last:border-0">
            <div className="shrink-0">
              {s.done ? <CheckCircle2 className="h-5 w-5 text-green-400" />
                : busy === s.id ? <Loader2 className="h-5 w-5 animate-spin text-magnet-400" />
                : <Circle className={`h-5 w-5 ${s.ready ? "text-magnet-400" : "text-gray-700"}`} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${s.done ? "text-gray-400 line-through" : "text-white"}`}>
                {i + 1}. {s.label}
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
        ))}
      </Panel>
    </div>
  );
}
