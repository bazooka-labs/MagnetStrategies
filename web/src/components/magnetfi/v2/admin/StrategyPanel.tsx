"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { ACTIVE } from "@/lib/magnetfi";
import * as ops from "@/lib/magnetfiOps";
import { getStrategyStats, type StrategyStats } from "@/lib/magnetfiReads";
import { Panel } from "../shared";
import { ActionForm, Section } from "./OperationsPanel";

const usd = (n: number, dp = 2) => n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

function StatCell({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "good" | "warn" }) {
  const c = tone === "good" ? "text-emerald-400" : tone === "warn" ? "text-yellow-400" : "text-white";
  return (
    <div className="rounded-lg border border-white/5 bg-black/20 p-3">
      <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 font-mono text-sm ${c}`}>{value}</p>
    </div>
  );
}

function StatsHeader({ s }: { s: StrategyStats }) {
  const deficit = s.deficit > 0;
  const ratioPct = (s.backingRatio * 100).toFixed(s.backingRatio >= 1 ? 0 : 2);
  return (
    <Panel className="p-6">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Reserve backing</p>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${deficit ? "bg-yellow-500/15 text-yellow-300" : "bg-emerald-500/15 text-emerald-300"}`}>
          {deficit ? `${ratioPct}% — restoration in progress` : `${ratioPct}% backed`}
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCell label="Circulating mUSD" value={usd(s.circulating)} />
        <StatCell label="Total backing" value={usd(s.totalBacking)} tone={deficit ? "warn" : "good"} />
        <StatCell label="On-chain USDC (buffer)" value={usd(s.onChainUsdc)} />
        <StatCell label="Deployed (recoverable)" value={usd(s.deployedBacking)} />
        <StatCell label="Reserve deficit" value={usd(s.deficit)} tone={deficit ? "warn" : "default"} />
        <StatCell label="Buffer floor" value={`${(s.bufferBps / 100).toFixed(0)}%`} />
        <StatCell label="Per-venue cap" value={`${(s.venueCapBps / 100).toFixed(0)}%`} />
        <StatCell label="Active adapters" value={String(s.adapters.length)} />
      </div>

      {s.adapters.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="py-1 pr-4 font-medium">Adapter</th>
                <th className="py-1 pr-4 font-medium">Principal</th>
                <th className="py-1 pr-4 font-medium">Recoverable</th>
                <th className="py-1 pr-4 font-medium">Yield</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="font-mono text-gray-300">
              {s.adapters.map((a) => {
                const loss = a.recoverable < a.principal - 0.000001;
                return (
                  <tr key={a.appId} className="border-t border-white/5">
                    <td className="py-1.5 pr-4">{a.appId}</td>
                    <td className="py-1.5 pr-4">{usd(a.principal)}</td>
                    <td className={`py-1.5 pr-4 ${loss ? "text-yellow-400" : ""}`}>{usd(a.recoverable)}</td>
                    <td className="py-1.5 pr-4 text-emerald-400">{a.yield > 0 ? `+${usd(a.yield)}` : "—"}</td>
                    <td className="py-1.5">
                      {a.impaired ? <span className="text-red-400">impaired</span>
                        : loss ? <span className="text-yellow-400">below principal</span>
                        : <span className="text-emerald-400">healthy</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function StrategyPanel() {
  const { address, algodClient, transactionSigner } = useWallet();
  const [psmId, setPsmId] = useState(ACTIVE.psm ? String(ACTIVE.psm) : "");
  const [stats, setStats] = useState<StrategyStats | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);

  const algorand = useMemo(
    () => (algodClient && transactionSigner ? ops.makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner],
  );

  useEffect(() => {
    if (!algodClient || !psmId) return;
    let alive = true;
    const load = async () => {
      try {
        const s = await getStrategyStats(algodClient, Number(psmId));
        if (alive) { setStats(s); setReadErr(null); }
      } catch (e) {
        if (alive) setReadErr(e instanceof Error ? e.message : "read failed");
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [algodClient, psmId]);

  const ready = !!algorand && !!address && !!psmId;
  const a = () => algorand!;
  const me = () => address!;
  const psm = () => BigInt(psmId);
  const usdc = () => ACTIVE.usdc;
  const base = (s: string) => BigInt(Math.round((Number(s) || 0) * 1_000_000));

  return (
    <div className="space-y-6">
      <Panel className="p-6">
        <p className="mb-3 text-sm font-semibold text-white">Productive Reserves (v3 PSM)</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">PSM v3 app ID</label>
            <input value={psmId} onChange={(e) => setPsmId(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-magnet-500/50" />
          </div>
        </div>
        <p className="mt-2 text-[11px] text-gray-600">
          Deploy idle reserve USDC into vetted, timelocked yield adapters (Folks first). Principal ↔ reserve,
          yield ↔ treasury. Redemptions always paid from the on-chain buffer.
        </p>
      </Panel>

      {readErr && (
        <Panel className="p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" />
            <p className="text-xs text-yellow-200/90">Could not read strategy state ({readErr}). Check the PSM v3 app ID.</p>
          </div>
        </Panel>
      )}

      {stats && <StatsHeader s={stats} />}

      {!ready ? (
        <Panel className="p-6">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" />
            <p className="text-xs text-yellow-200/90">Enter the PSM v3 app ID and connect the admin/guardian wallet to enable operations.</p>
          </div>
        </Panel>
      ) : (
        <div className="space-y-8">
          <Section title="Strategy — deploy / recall / harvest">
            <ActionForm title="Deploy to venue" desc="Route idle USDC → adapter → Folks. Bounded by buffer + per-venue cap. Amount in USDC."
              fields={[{ key: "ad", label: "Adapter app ID" }, { key: "u", label: "USDC amount" }]} button="Deploy"
              onRun={(v) => ops.strategyDeploy(a(), me(), psm(), BigInt(v.ad), base(v.u))} />
            <ActionForm title="Recall from venue" desc="Withdraw USDC back to the buffer (principal → reserve). Amount in USDC."
              fields={[{ key: "ad", label: "Adapter app ID" }, { key: "u", label: "USDC amount" }]} button="Recall"
              onRun={(v) => ops.strategyRecall(a(), me(), psm(), BigInt(v.ad), base(v.u))} />
            <ActionForm title="Harvest yield" desc="Sweep realized yield (recoverable − principal) to treasury. Halted during deficit/impairment."
              fields={[{ key: "ad", label: "Adapter app ID" }]} button="Harvest"
              onRun={(v) => ops.strategyHarvest(a(), me(), psm(), BigInt(v.ad))} />
          </Section>

          <Section title="Adapter whitelist — 48h timelock + guardian veto">
            <ActionForm title="Propose adapter" desc="Queue whitelisting a yield adapter. Takes effect after 48h."
              fields={[{ key: "ad", label: "Adapter app ID" }]} button="Propose" tone="warn"
              onRun={(v) => ops.proposeAdapter(a(), me(), psm(), BigInt(v.ad))} />
            <ActionForm title="Confirm adapter" desc="Whitelist a queued adapter after the timelock elapses." fields={[]} button="Confirm" tone="warn"
              onRun={() => ops.confirmAdapter(a(), me(), psm())} />
            <ActionForm title="Cancel pending adapter" desc="Guardian veto on a queued whitelist." fields={[]} button="Cancel"
              onRun={() => ops.cancelAdapter(a(), me(), psm())} />
            <ActionForm title="Remove adapter" desc="De-whitelist. Healthy: must be fully recalled + empty. Impaired: writes off principal to deficit."
              fields={[{ key: "ad", label: "Adapter app ID" }]} button="Remove" tone="danger"
              onRun={(v) => ops.removeAdapter(a(), me(), psm(), BigInt(v.ad))} />
          </Section>

          <Section title="Reserve deficit & impairment">
            <ActionForm title="Restore deficit" desc="Deposit USDC to pay down reserve_deficit. Re-enables issuance at zero. Amount in USDC."
              fields={[{ key: "u", label: "USDC amount" }]} button="Restore"
              onRun={(v) => ops.restore(a(), me(), psm(), base(v.u), usdc())} />
            <ActionForm title="Mark impaired" desc="Flag a venue (value loss OR withdrawal halt). Freezes issuance. Admin or guardian."
              fields={[{ key: "ad", label: "Adapter app ID" }]} button="Mark impaired" tone="warn"
              onRun={(v) => ops.markImpaired(a(), me(), psm(), BigInt(v.ad), BigInt(1))} />
            <ActionForm title="Clear impairment" desc="Un-impair a venue. Guardian only (mirrors unpause)."
              fields={[{ key: "ad", label: "Adapter app ID" }]} button="Clear impairment"
              onRun={(v) => ops.markImpaired(a(), me(), psm(), BigInt(v.ad), BigInt(0))} />
          </Section>

          <Section title="Guardrails">
            <ActionForm title="Set buffer floor" desc="Min on-chain USDC fraction of total reserve (bps). Start ≥ 7000 (70%)."
              fields={[{ key: "b", label: "Buffer (bps)" }]} button="Set buffer"
              onRun={(v) => ops.setBufferBps(a(), me(), psm(), BigInt(v.b))} />
            <ActionForm title="Set per-venue cap" desc="Max single-venue exposure fraction of total reserve (bps)."
              fields={[{ key: "c", label: "Cap (bps)" }]} button="Set cap"
              onRun={(v) => ops.setVenueCapBps(a(), me(), psm(), BigInt(v.c))} />
          </Section>

          <Section title="Treasury — timelocked change (harvest destination)">
            <ActionForm title="Propose treasury" desc="Queue a treasury change. 48h timelock; guardian can cancel. Initial set uses Set treasury (Operations)."
              fields={[{ key: "t", label: "New treasury address" }]} button="Propose" tone="warn"
              onRun={(v) => ops.proposeTreasury(a(), me(), psm(), v.t)} />
            <ActionForm title="Confirm treasury" desc="After the 48h timelock elapses." fields={[]} button="Confirm" tone="warn"
              onRun={() => ops.confirmTreasury(a(), me(), psm())} />
            <ActionForm title="Cancel treasury change" desc="Guardian veto." fields={[]} button="Cancel"
              onRun={() => ops.cancelTreasury(a(), me(), psm())} />
          </Section>
        </div>
      )}
    </div>
  );
}
