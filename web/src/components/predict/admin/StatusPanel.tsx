"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel } from "@/components/magnetfi/v2/shared";
import { makeAlgorand, readGlobals, readRound, readSolvency, type RoundView } from "@/lib/vplOps";
import { BAND_COUNT, STATUS, VOID_REASON, VPL_APP_ID, bandLabel, bandMultipleBps, fmtUsd } from "@/lib/vpl";

type Globals = Awaited<ReturnType<typeof readGlobals>>;
type Solvency = Awaited<ReturnType<typeof readSolvency>>;

const when = (ts: number) =>
  ts ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export function StatusPanel() {
  const { address, algodClient, transactionSigner } = useWallet();
  const [globals, setGlobals] = useState<Globals>();
  const [solvency, setSolvency] = useState<Solvency>();
  const [round, setRound] = useState<RoundView>();
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!VPL_APP_ID || !algodClient || !address) return;
    setLoading(true);
    try {
      const a = makeAlgorand(algodClient, transactionSigner!);
      const g = await readGlobals(a, BigInt(VPL_APP_ID), address);
      setGlobals(g);
      setSolvency(await readSolvency(a, BigInt(VPL_APP_ID), address));
      if (g.roundCount) setRound(await readRound(a, BigInt(VPL_APP_ID), address, g.roundCount));
    } finally {
      setLoading(false);
    }
  }, [address, algodClient, transactionSigner]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!VPL_APP_ID) {
    return (
      <Panel className="p-6">
        <p className="text-sm text-gray-400">
          Not deployed. Set <code className="font-mono text-magnet-200">NEXT_PUBLIC_VPL_APP_ID</code> after
          running the deploy steps.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          App <code className="font-mono text-magnet-200">{VPL_APP_ID}</code>
          {globals?.paused && <span className="ml-3 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-300">PAUSED</span>}
        </p>
        <button onClick={() => void refresh()} disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:text-white disabled:opacity-40">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* Solvency — invariant 1, checkable by anyone */}
      {solvency && (
        <Panel className="p-6">
          <div className="mb-4 flex items-center gap-2">
            {solvency.solvent
              ? <ShieldCheck className="h-4 w-4 text-green-400" />
              : <ShieldAlert className="h-4 w-4 text-red-400" />}
            <p className="text-sm font-semibold text-white">
              Solvency {solvency.solvent ? "OK" : "VIOLATED"}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["mUSD held", solvency.balance],
              ["Owed to users", solvency.obligations],
              ["Rake owed", solvency.rakeOwed],
            ].map(([label, v]) => (
              <div key={String(label)}>
                <p className="text-xs text-gray-500">{label as string}</p>
                <p className="font-mono text-lg text-white">{fmtUsd(v as bigint)}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-600">
            Balance must be at least obligations + rake. The contract asserts this before either sweep,
            so a bookkeeping drift fails closed rather than authorising a transfer.
          </p>
        </Panel>
      )}

      {/* Current round */}
      {round && globals && (
        <Panel className="p-6">
          <div className="mb-4 flex items-baseline justify-between">
            <p className="text-sm font-semibold text-white">Round {globals.roundCount}</p>
            <p className="text-xs">
              <span className="rounded-lg border border-white/10 px-2 py-0.5 font-semibold text-magnet-200">
                {STATUS[round.status] ?? round.status}
                {round.status === 3 && ` · ${VOID_REASON[round.voidReason] ?? round.voidReason}`}
              </span>
            </p>
          </div>

          <div className="mb-5 grid gap-3 text-xs sm:grid-cols-3">
            <div><p className="text-gray-500">Entry closes</p><p className="text-gray-200">{when(round.lockTime)}</p></div>
            <div><p className="text-gray-500">Settles</p><p className="text-gray-200">{when(round.resolveTime)}</p></div>
            <div>
              <p className="text-gray-500">Pot</p>
              <p className="text-gray-200">{fmtUsd(round.totalStake)} mUSD · {round.positionCount} position(s)</p>
            </div>
            {round.referencePrice > BigInt(0) && (
              <div><p className="text-gray-500">Reference</p><p className="font-mono text-gray-200">{fmtUsd(round.referencePrice)}</p></div>
            )}
            {round.settlementPrice > BigInt(0) && (
              <div><p className="text-gray-500">Settlement</p><p className="font-mono text-gray-200">{fmtUsd(round.settlementPrice)}</p></div>
            )}
            {round.status === 2 && (
              <div><p className="text-gray-500">Payable pot</p><p className="font-mono text-gray-200">{fmtUsd(round.payablePot)}</p></div>
            )}
          </div>

          {/* Ladder */}
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Ladder</p>
          <div className="space-y-1">
            {Array.from({ length: BAND_COUNT }, (_, i) => {
              const stake = round.bandStake[i] ?? BigInt(0);
              const mult = bandMultipleBps(round.totalStake, round.rakeBps, stake);
              const share = round.totalStake > BigInt(0)
                ? Number((stake * BigInt(1000)) / round.totalStake) / 10 : 0;
              const isWinner = round.status === 2 && i === round.winningBand;
              return (
                <div key={i} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs ${
                  isWinner ? "bg-green-500/10 ring-1 ring-green-500/30" : ""}`}>
                  <span className="w-28 shrink-0 font-mono text-gray-400">{bandLabel(i)}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                    <div className="h-full rounded-full bg-gradient-to-r from-magnet-600 to-magnet-400"
                      style={{ width: `${share}%` }} />
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono text-gray-300">
                    {stake > BigInt(0) ? `${fmtUsd(stake, 0)}` : "—"}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-magnet-200">
                    {mult > BigInt(0) ? `${(Number(mult) / 10_000).toFixed(2)}x` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-gray-600">
            Multiples move until entry closes — they are a function of where the money sits, not a
            quoted price. A thin band pays more precisely because few are on it.
          </p>
        </Panel>
      )}

      {globals && (
        <Panel className="p-6">
          <p className="mb-3 text-sm font-semibold text-white">Configuration</p>
          <div className="grid gap-3 text-xs sm:grid-cols-4">
            <div><p className="text-gray-500">Rake</p><p className="text-gray-200">{globals.rakeBps / 100}%</p></div>
            <div><p className="text-gray-500">Min stake</p><p className="text-gray-200">{fmtUsd(globals.minStake)} mUSD</p></div>
            <div><p className="text-gray-500">Rounds run</p><p className="text-gray-200">{globals.roundCount}</p></div>
            <div><p className="text-gray-500">Open round</p><p className="text-gray-200">{globals.openRoundId || "none"}</p></div>
            <div><p className="text-gray-500">Fee reserve</p><p className="text-gray-200">{(globals.feeReserve / 1e6).toFixed(3)} ALGO</p></div>
            <div><p className="text-gray-500">MBR reserve</p><p className="text-gray-200">{(globals.mbrReserve / 1e6).toFixed(3)} ALGO</p></div>
            <div><p className="text-gray-500">Last settlement</p><p className="font-mono text-gray-200">{globals.lastSettlementPrice ? fmtUsd(globals.lastSettlementPrice) : "—"}</p></div>
            <div><p className="text-gray-500">mUSD asset</p><p className="font-mono text-gray-200">{globals.musdAssetId}</p></div>
          </div>
        </Panel>
      )}
    </div>
  );
}
