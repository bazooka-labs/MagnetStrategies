"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Loader2, Copy, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import {
  ACTIVE, VAULT_TYPES, poolWiring, healthFactor, liquidationBuffer,
  projectedAccruedInterest, formatUsd, pct,
} from "@/lib/magnetfi";
import { getAllPositions, getOracle, type AdminPosition, type OracleInfo } from "@/lib/magnetfiReads";
import * as ops from "@/lib/magnetfiOps";
import { Panel } from "../shared";

const GRACE_DAYS = 90;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function hfColor(hf: number): string {
  if (hf === Infinity || hf >= 1.15) return "text-green-400";
  if (hf >= 1.0) return "text-yellow-400";
  return "text-red-400";
}

/** Reverse-map a poolId to its VaultType via the live pool wiring. */
function vtByPool(poolId: number) {
  return VAULT_TYPES.find((vt) => poolWiring(vt.id)?.poolId === poolId);
}

/** Two-click liquidation button: first click arms (4s), second click fires. Irreversible action. */
function LiqButton({ label, tone, disabled, onRun }: {
  label: string; tone: "warn" | "danger"; disabled?: boolean; onRun: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const armedAt = useRef(0);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const grad = tone === "danger" ? "from-red-600 to-red-500" : "from-yellow-600 to-yellow-500";
  return (
    <button
      disabled={disabled || busy}
      onClick={async () => {
        if (!armed) { setArmed(true); armedAt.current = Date.now(); return; }
        if (Date.now() - armedAt.current < 400) return; // ignore fast double-click on an irreversible action
        setBusy(true);
        try { await onRun(); } finally { setBusy(false); setArmed(false); }
      }}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        armed ? `bg-gradient-to-r ${grad} ring-2 ring-white/40` : "border border-white/15 bg-black/40 hover:border-white/30"
      }`}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {armed ? `Confirm — ${label}` : label}
    </button>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 font-mono text-sm ${tone ?? "text-white"}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

export function PositionsPanel() {
  const { address, algodClient, transactionSigner } = useWallet();
  const algorand = useMemo(
    () => (algodClient && transactionSigner ? ops.makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner],
  );
  const ready = !!algorand && !!address && !!ACTIVE.vault;

  const [positions, setPositions] = useState<AdminPosition[]>([]);
  const [oracles, setOracles] = useState<Record<number, OracleInfo>>({});
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!algodClient) return;
    setLoading(true);
    try {
      const ps = await getAllPositions(algodClient);
      const poolIds = [...new Set(ps.map((p) => p.poolId))];
      const od = await Promise.all(poolIds.map((pid) => getOracle(algodClient, pid).then((o) => [pid, o] as const)));
      setOracles(Object.fromEntries(od));
      setPositions(ps);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load positions");
    } finally {
      setLoading(false);
    }
  }, [algodClient]);

  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, label: string) => {
    try { await fn(); toast.success(`${label} ✓`); await load(); }
    catch (e) {
      const m = e instanceof Error ? e.message : "Transaction failed";
      toast.error(m.includes("rejected") ? "Signing cancelled" : m.slice(0, 140));
    }
  };

  const copy = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 1500);
  };

  // Derived view rows.
  const rows = positions.map((p) => {
    const vt = vtByPool(p.poolId);
    const oracle = oracles[p.poolId];
    const price = oracle?.price ?? 0;
    const hfKnown = !!oracle && oracle.fresh && price > 0;
    const liqBps = vt?.liqThresholdBps ?? 7500;
    const liveInterest = p.vaultState !== 2
      ? projectedAccruedInterest(p.accruedInterest, p.musdBorrowed, p.rateBps, p.lastAccrualTs, nowSec)
      : p.accruedInterest;
    const value = p.lpAmount * price;
    const debt = p.musdBorrowed + liveInterest;
    const hf = hfKnown ? healthFactor(value, debt, liqBps) : NaN;
    const buffer = hfKnown ? liquidationBuffer(value, debt, liqBps) * 100 : NaN;
    const daysLeft = GRACE_DAYS - Math.floor((nowSec - p.lastPaymentTs) / 86400);
    const pastDue = p.lastPaymentTs > 0 && daysLeft <= 0;
    return { p, vt, oracle, price, hfKnown, hf, buffer, value, debt, liveInterest, daysLeft, pastDue };
  });

  const totalBorrowed = positions.reduce((a, p) => a + p.musdBorrowed, 0);
  const pastDueCount = rows.filter((r) => r.pastDue).length;
  const atRiskCount = rows.filter((r) => r.hfKnown && r.hf < 1.1).length;

  return (
    <div className="space-y-4">
      {/* Summary header */}
      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-gray-500">Active loans</p>
              <p className="font-mono text-lg font-bold text-white">{positions.length}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-gray-500">Total borrowed</p>
              <p className="font-mono text-lg font-bold text-white">${formatUsd(totalBorrowed)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-gray-500">Past due</p>
              <p className={`font-mono text-lg font-bold ${pastDueCount ? "text-red-400" : "text-white"}`}>{pastDueCount}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-gray-500">At risk (HF&lt;1.1)</p>
              <p className={`font-mono text-lg font-bold ${atRiskCount ? "text-yellow-400" : "text-white"}`}>{atRiskCount}</p>
            </div>
          </div>
          <button onClick={load} disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-gray-300 hover:border-white/30 disabled:opacity-40">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>
      </Panel>

      {loading && positions.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">Loading positions…</p>
      ) : positions.length === 0 ? (
        <Panel className="p-8"><p className="text-center text-sm text-gray-400">No active loans.</p></Panel>
      ) : (
        rows.map(({ p, vt, oracle, hfKnown, hf, buffer, value, liveInterest, daysLeft, pastDue }) => {
          const inSettlement = p.vaultState === 2;
          const dueTone = pastDue ? "text-red-400" : daysLeft <= 14 ? "text-yellow-400" : "text-green-400";
          return (
            <Panel key={`${p.borrower}-${p.poolId}`} className="p-5">
              {/* Row header: borrower + pool + HF */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-white">{short(p.borrower)}</span>
                  <button onClick={() => copy(p.borrower)} className="text-gray-500 hover:text-white">
                    {copied === p.borrower ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-gray-300">
                    {vt ? `${vt.tokens[0]} / ${vt.tokens[1]}` : `pool ${p.poolId}`}
                  </span>
                  {inSettlement && (
                    <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-300">
                      In settlement
                    </span>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-[11px] uppercase tracking-wider text-gray-500">Health factor</p>
                  <p className={`font-mono text-xl font-bold ${hfKnown ? hfColor(hf) : "text-gray-500"}`}>
                    {inSettlement ? "—" : hfKnown ? (hf === Infinity ? "∞" : hf.toFixed(2)) : "n/a"}
                  </p>
                </div>
              </div>

              {/* Metrics */}
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Collateral" value={`${formatUsd(p.lpAmount)} LP`} sub={hfKnown ? `$${formatUsd(value)}` : "price stale"} />
                <Metric label="Borrowed" value={`${formatUsd(p.musdBorrowed)} mUSD`} />
                <Metric label={inSettlement ? "Settlement remaining" : "Accrued interest"} value={`${formatUsd(liveInterest, 4)}`} sub={`@ ${pct(p.rateBps)}% APR`} />
                <Metric
                  label="Interest payment"
                  value={p.lastPaymentTs === 0 ? "—" : pastDue ? `${-daysLeft}d past due` : `${daysLeft}d left`}
                  tone={dueTone}
                />
              </div>

              {hfKnown && !inSettlement && Number.isFinite(buffer) && (
                <p className="mt-2 text-[11px] text-gray-500">Liquidation buffer: {formatUsd(Math.max(0, Math.min(100, buffer)), 1)}% price drop</p>
              )}
              {!hfKnown && !inSettlement && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-yellow-400/90">
                  <AlertTriangle className="h-3 w-3" /> Oracle stale for this pool — health factor unavailable; price-based liquidations disabled (micro-liquidation also needs a fresh price).
                </p>
              )}

              {/* Actions */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {inSettlement ? (
                  <p className="text-xs text-gray-500">Complete via Operations → “Settle health liquidation”.</p>
                ) : (
                  <>
                    {hfKnown && hf < 0.85 && (
                      <LiqButton label="Full liquidation" tone="danger" disabled={!ready}
                        onRun={() => run(() => ops.triggerFull(algorand!, address!, BigInt(ACTIVE.vault), p.borrower, BigInt(p.poolId)), "Full liquidation")} />
                    )}
                    {hfKnown && hf >= 0.85 && hf < 0.95 && (
                      <LiqButton label="Partial liquidation · Tier 2 (77%)" tone="danger" disabled={!ready}
                        onRun={() => run(() => ops.triggerPartial(algorand!, address!, BigInt(ACTIVE.vault), p.borrower, BigInt(p.poolId), BigInt(2)), "Tier 2 liquidation")} />
                    )}
                    {hfKnown && hf >= 0.95 && hf < 1.0 && (
                      <LiqButton label="Partial liquidation · Tier 1 (35%)" tone="warn" disabled={!ready}
                        onRun={() => run(() => ops.triggerPartial(algorand!, address!, BigInt(ACTIVE.vault), p.borrower, BigInt(p.poolId), BigInt(1)), "Tier 1 liquidation")} />
                    )}
                    {pastDue && p.vaultState === 0 && (
                      <LiqButton label="Mark overdue (step 1)" tone="warn" disabled={!ready}
                        onRun={() => run(() => ops.markOverdue(algorand!, address!, BigInt(ACTIVE.vault), p.borrower, BigInt(p.poolId)), "Marked overdue")} />
                    )}
                    {p.vaultState === 1 && (
                      <LiqButton label="Micro-liquidate (overdue interest)" tone="warn" disabled={!ready || !oracle?.fresh}
                        onRun={() => run(() => ops.triggerMicro(algorand!, address!, BigInt(ACTIVE.vault), p.borrower, BigInt(p.poolId)), "Micro-liquidation")} />
                    )}
                    {hfKnown && hf >= 1.0 && !pastDue && p.vaultState === 0 && (
                      <span className="text-xs text-gray-500">Healthy — no action required.</span>
                    )}
                  </>
                )}
                {oracle && !oracle.fresh && !inSettlement && (
                  <span className="text-[11px] text-gray-600">oracle {Math.floor((nowSec - oracle.ts) / 60)}m old</span>
                )}
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}
