"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Info, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import {
  VAULT_TYPES, PROTOCOL_LIVE, pct, formatUsd, maxBorrow, healthFactor, liquidationBuffer,
} from "@/lib/magnetfi";
import {
  makeAlgorand, optIn, openVault, payInterest, repayPrincipal, borrowMore, addCollateral,
} from "@/lib/magnetfiClient";
import {
  getOracle, getVaultPosition, getBalances,
  MUSD_ID, type OracleInfo, type VaultPosition, type Balances,
} from "@/lib/magnetfiReads";
import { Panel, PairGlyph, PrimaryButton, NotLiveNote } from "./shared";

const POOL = VAULT_TYPES.find((v) => v.status === "launching")!; // U/tALGO

function hfColor(hf: number): string {
  if (hf === Infinity) return "text-gray-400";
  if (hf >= 1.5) return "text-green-400";
  if (hf >= 1.15) return "text-yellow-400";
  return "text-red-400";
}

export function VaultsTab() {
  const { address, isConnected, algodClient, transactionSigner } = useWallet();
  const [oracle, setOracle] = useState<OracleInfo | null>(null);
  const [pos, setPos] = useState<VaultPosition | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // open form
  const [lp, setLp] = useState("");
  const [borrow, setBorrow] = useState("");
  // manage forms
  const [m, setM] = useState<Record<string, string>>({});

  const algorand = useMemo(
    () => (algodClient && transactionSigner ? makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner]);

  const refresh = useCallback(async () => {
    if (!PROTOCOL_LIVE || !algodClient) return;
    try {
      const [o, p, b] = await Promise.all([
        getOracle(algodClient),
        address ? getVaultPosition(algodClient, address) : Promise.resolve(null),
        address ? getBalances(algodClient, address) : Promise.resolve(null),
      ]);
      setOracle(o); setPos(p); setBal(b);
    } catch { /* ignore */ }
  }, [algodClient, address]);
  useEffect(() => { refresh(); }, [refresh]);

  const price = oracle?.price ?? 0;
  const fresh = !!oracle?.fresh;

  // open-form math
  const lpAmt = Math.max(0, Number(lp) || 0);
  const collateralUsd = lpAmt * price;
  const cap = maxBorrow(collateralUsd, POOL.ltvBps);
  const borrowAmt = Math.min(Math.max(0, Number(borrow) || 0), cap || 0);
  const openHf = healthFactor(collateralUsd, borrowAmt, POOL.liqThresholdBps);

  async function run(id: string, fn: () => Promise<void>, optAsset?: number) {
    if (!algorand || !address) return;
    setBusy(id);
    try {
      // Ensure mUSD opt-in before any action that can RECEIVE mUSD (open w/ borrow,
      // borrow more). Fetch balances if not loaded yet so a required opt-in is never skipped.
      if (optAsset === MUSD_ID) {
        let b = bal;
        if (!b && algodClient) b = await getBalances(algodClient, address);
        if (b && !b.optedMusd) { await optIn(algorand, address, MUSD_ID); toast.success("Opted into mUSD"); }
      }
      await fn();
      toast.success("Done");
      setLp(""); setBorrow(""); setM({});
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transaction failed";
      toast.error(msg.includes("rejected") ? "Signing cancelled" : msg.slice(0, 140));
    } finally { setBusy(null); }
  }

  // ── position math ──
  const posValue = pos ? pos.lpAmount * price : 0;
  const posDebt = pos ? pos.musdBorrowed + pos.accruedInterest : 0;
  const posHf = pos ? healthFactor(posValue, posDebt, POOL.liqThresholdBps) : Infinity;

  function ManageAction({ id, label, unit, onRun, disabled, max }: {
    id: string; label: string; unit: string; onRun: (v: number) => Promise<void>;
    disabled?: boolean; max?: number;
  }) {
    const v = m[id] ?? "";
    const num = Number(v) || 0;
    const amount = max !== undefined ? Math.min(num, max) : num;   // clamp (H-1)
    return (
      <div className="flex items-center gap-2">
        <input value={v} disabled={disabled}
          onChange={(e) => setM((s) => ({ ...s, [id]: e.target.value }))}
          placeholder={disabled ? "clear interest first" : `${label} (${unit})`}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-magnet-500/50 disabled:opacity-40" />
        <button onClick={() => run(id, () => onRun(amount), MUSD_ID)} disabled={busy !== null || disabled || !(amount > 0)}
          className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-30">
          {busy === id ? <Loader2 className="h-4 w-4 animate-spin" /> : label}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Intro + oracle */}
      <Panel className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <PairGlyph tokens={POOL.tokens} />
            <div>
              <h2 className="text-lg font-semibold text-white">{POOL.pair} vault</h2>
              <p className="mt-0.5 text-sm text-gray-400">
                Borrow mUSD against your LP — interest-only, repay any time.
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wider text-gray-500">LP price</p>
            <p className="font-mono text-lg font-bold text-white">
              {PROTOCOL_LIVE ? (oracle ? `$${formatUsd(price, 4)}` : "…") : "Soon"}
            </p>
            {oracle && (
              <span className={`text-[11px] ${fresh ? "text-green-400" : "text-red-400"}`}>
                {fresh ? "oracle fresh" : "oracle stale"}
              </span>
            )}
          </div>
        </div>
      </Panel>

      {!PROTOCOL_LIVE && (
        <Panel className="p-10"><p className="text-center text-sm text-gray-400">Vaults open once the contracts are live.</p></Panel>
      )}

      {/* Existing position */}
      {PROTOCOL_LIVE && pos && (
        <Panel className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Your {POOL.pair} vault</p>
            <button onClick={refresh} className="text-gray-500 hover:text-white"><RefreshCw className="h-3.5 w-3.5" /></button>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Collateral</p>
              <p className="mt-1 font-mono text-white">{formatUsd(pos.lpAmount)} LP</p>
              <p className="text-xs text-gray-500">${formatUsd(posValue)}</p></div>
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Borrowed</p>
              <p className="mt-1 font-mono text-white">{formatUsd(pos.musdBorrowed)}</p></div>
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Accrued interest</p>
              <p className="mt-1 font-mono text-white">{formatUsd(pos.accruedInterest, 4)}</p></div>
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Health factor</p>
              <p className={`mt-1 font-mono font-bold ${hfColor(posHf)}`}>{posHf === Infinity ? "∞" : posHf.toFixed(2)}</p></div>
          </div>
          {pos.vaultState === 2 && (
            <p className="mt-3 text-xs text-red-400">In liquidation — borrower actions are paused until settlement completes.</p>
          )}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <ManageAction id="pay" label="Pay interest" unit="mUSD" onRun={(v) => payInterest(algorand!, address!, v)} />
            <ManageAction id="repay" label="Repay principal" unit="mUSD" disabled={pos.accruedInterest > 0} max={pos.musdBorrowed} onRun={(v) => repayPrincipal(algorand!, address!, v)} />
            <ManageAction id="borrow" label="Borrow more" unit="mUSD" onRun={(v) => borrowMore(algorand!, address!, v)} />
            <ManageAction id="add" label="Add collateral" unit="LP" onRun={(v) => addCollateral(algorand!, address!, v)} />
          </div>
          <p className="mt-3 text-[11px] text-gray-600">Tip: clear accrued interest with “Pay interest” before repaying principal.</p>
        </Panel>
      )}

      {/* Open new vault */}
      {PROTOCOL_LIVE && !pos && (
        <Panel className="p-6">
          <p className="mb-4 text-sm font-semibold text-white">Open a vault</p>
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-5">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium uppercase tracking-wider text-gray-500">Deposit LP</label>
                  {bal && <button onClick={() => setLp(String(bal.lp))} className="text-xs text-magnet-300 hover:text-magnet-200">Max {formatUsd(bal.lp)}</button>}
                </div>
                <div className="flex items-center rounded-xl border border-white/10 bg-black/40 px-4 focus-within:border-magnet-500/50">
                  <input type="number" min={0} value={lp} onChange={(e) => setLp(e.target.value)}
                    className="w-full bg-transparent px-1 py-3 font-mono text-lg text-white outline-none" placeholder="0" />
                  <span className="text-xs text-gray-500">LP</span>
                </div>
                <p className="mt-1.5 text-xs text-gray-500">Collateral value: ${formatUsd(collateralUsd)}</p>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium uppercase tracking-wider text-gray-500">Borrow mUSD</label>
                  <button onClick={() => setBorrow(String(Math.floor(cap)))} className="text-xs text-magnet-300 hover:text-magnet-200">Max {formatUsd(cap, 0)}</button>
                </div>
                <div className="flex items-center rounded-xl border border-white/10 bg-black/40 px-4 focus-within:border-magnet-500/50">
                  <input type="number" min={0} value={borrow} onChange={(e) => setBorrow(e.target.value)}
                    className="w-full bg-transparent px-1 py-3 font-mono text-lg text-white outline-none" placeholder="0" />
                  <span className="text-xs text-gray-500">mUSD</span>
                </div>
                <p className="mt-1.5 text-xs text-gray-500">{pct(POOL.ltvBps)}% max LTV</p>
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-white/5 bg-black/20 p-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Health factor</span>
                <span className={`font-mono text-2xl font-bold ${hfColor(openHf)}`}>{openHf === Infinity ? "∞" : openHf.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-white/5 pt-3 text-sm">
                <span className="text-gray-400">Liquidation buffer</span>
                <span className="font-mono text-white">{borrowAmt > 0 ? `${formatUsd(liquidationBuffer(collateralUsd, borrowAmt, POOL.liqThresholdBps) * 100, 1)}% drop` : "—"}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Interest / year</span>
                <span className="font-mono text-white">{formatUsd(borrowAmt * (POOL.rateBps / 10_000))} mUSD ({pct(POOL.rateBps)}%)</span>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-white/5 bg-black/30 px-3 py-2.5">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-magnet-400" />
                <p className="text-xs leading-relaxed text-gray-500">Liquidation begins at a health factor of 1.00. Repay or add collateral to stay above it.</p>
              </div>
              <PrimaryButton
                onClick={() => run("open", () => openVault(algorand!, address!, lpAmt, borrowAmt), borrowAmt > 0 ? MUSD_ID : undefined)}
                disabled={!isConnected || busy !== null || lpAmt <= 0 || (borrowAmt > 0 && !fresh) || (!!bal && bal.lp < lpAmt)}>
                {busy === "open" ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Confirm in wallet…</span>
                  : !isConnected ? "Connect wallet to borrow"
                  : (!!bal && bal.lp < lpAmt) ? "Insufficient LP"
                  : borrowAmt > 0 && !fresh ? "Oracle stale — borrow blocked"
                  : "Open vault"}
              </PrimaryButton>
              {borrowAmt > 0 && !fresh && (
                <p className="text-center text-[11px] text-gray-500">A borrow needs a fresh oracle price. Depositing collateral with 0 borrow is allowed.</p>
              )}
            </div>
          </div>
        </Panel>
      )}

      {PROTOCOL_LIVE && !pos && !isConnected && <NotLiveNote />}
    </div>
  );
}
