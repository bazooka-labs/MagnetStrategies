"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Info, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import {
  VAULT_TYPES, PROTOCOL_LIVE, pct, formatUsd, maxBorrow, healthFactor, liquidationBuffer,
  projectedAccruedInterest, poolWiring, type VaultType,
} from "@/lib/magnetfi";
import {
  makeAlgorand, optIn, openVault, payInterest, repayPrincipal, borrowMore, addCollateral,
  type PoolRef,
} from "@/lib/magnetfiClient";
import {
  getOracle, getVaultPosition, getBalances,
  MUSD_ID, type OracleInfo, type VaultPosition, type Balances,
} from "@/lib/magnetfiReads";
import { Panel, PairGlyph, PrimaryButton } from "./shared";

// Collateral pools with on-chain wiring — one live vault panel each. A VaultType without wiring
// (poolWiring undefined) is not yet configured on-chain and is omitted here.
const LIVE_VAULTS = VAULT_TYPES
  .map((vt) => ({ vt, pool: poolWiring(vt.id) }))
  .filter((x): x is { vt: VaultType; pool: PoolRef } => !!x.pool);

function hfColor(hf: number): string {
  if (hf === Infinity) return "text-gray-400";
  if (hf >= 1.5) return "text-green-400";
  if (hf >= 1.15) return "text-yellow-400";
  return "text-red-400";
}

// Hoisted to module scope (not declared inside a panel) so the 60s live-interest tick —
// or any parent re-render — does NOT remount its <input> and steal focus mid-typing.
function ManageAction({ id, label, unit, onRun, disabled, max, maxFill, m, setM, run, busy }: {
  id: string; label: string; unit: string; onRun: (v: number) => Promise<void>;
  disabled?: boolean; max?: number; maxFill?: number;
  m: Record<string, string>;
  setM: Dispatch<SetStateAction<Record<string, string>>>;
  run: (id: string, fn: () => Promise<void>, optAsset?: number) => Promise<void>;
  busy: string | null;
}) {
  const v = m[id] ?? "";
  const num = Number(v) || 0;
  const amount = max !== undefined ? Math.min(num, max) : num;   // clamp (H-1)
  const showMax = maxFill !== undefined && maxFill > 0 && !disabled;
  return (
    <div className="flex items-center gap-2">
      <div className="relative w-full">
        <input value={v} disabled={disabled}
          onChange={(e) => setM((s) => ({ ...s, [id]: e.target.value }))}
          placeholder={disabled ? "clear interest first" : `${label} (${unit})`}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 pr-12 font-mono text-sm text-white outline-none focus:border-magnet-500/50 disabled:opacity-40" />
        {showMax && (
          <button type="button" onClick={() => setM((s) => ({ ...s, [id]: String(maxFill) }))}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-magnet-400 hover:text-magnet-300">
            Max
          </button>
        )}
      </div>
      <button onClick={() => run(id, () => onRun(amount), MUSD_ID)} disabled={busy !== null || disabled || !(amount > 0)}
        className="shrink-0 rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-30">
        {busy === id ? <Loader2 className="h-4 w-4 animate-spin" /> : label}
      </button>
    </div>
  );
}

// One self-contained vault for a single collateral pool: reads its own oracle/position/balances
// (parameterized by pool.poolId / pool.lpAsaId) and routes every write to that pool. All state is
// local so multiple panels on the page are fully independent.
function HeaderMetric({ label, value, sub, subClass }: {
  label: string; value: string; sub?: string; subClass?: string;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-0.5 font-mono text-base font-bold text-white">{value}</p>
      {sub && <p className={`text-[11px] ${subClass ?? "text-gray-500"}`}>{sub}</p>}
    </div>
  );
}

function VaultPanel({ vt, pool }: { vt: VaultType; pool: PoolRef }) {
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
        getOracle(algodClient, pool.poolId),
        address ? getVaultPosition(algodClient, address, pool.poolId) : Promise.resolve(null),
        address ? getBalances(algodClient, address, pool.lpAsaId) : Promise.resolve(null),
      ]);
      setOracle(o); setPos(p); setBal(b);
    } catch { /* ignore */ }
  }, [algodClient, address, pool.poolId, pool.lpAsaId]);
  useEffect(() => { refresh(); }, [refresh]);

  const price = oracle?.price ?? 0;
  const fresh = !!oracle?.fresh;

  // open-form math
  const lpAmt = Math.max(0, Number(lp) || 0);
  const collateralUsd = lpAmt * price;
  const cap = maxBorrow(collateralUsd, vt.ltvBps);
  const borrowAmt = Math.min(Math.max(0, Number(borrow) || 0), cap || 0);
  const openHf = healthFactor(collateralUsd, borrowAmt, vt.liqThresholdBps);
  // The entered borrow is clamped to `cap` (H-1) and everything downstream (preview HF, buffer,
  // Open) uses the clamped `borrowAmt` — surface when the input exceeds the cap so the field never
  // silently disagrees. (The contract independently rejects any borrow > cap: "exceeds LTV".)
  const overCap = cap > 0 && (Number(borrow) || 0) > cap;

  async function run(id: string, fn: () => Promise<void>, optAsset?: number) {
    if (!algorand || !address) return;
    setBusy(id);
    try {
      // Ensure mUSD opt-in before any action that can RECEIVE mUSD (open w/ borrow,
      // borrow more). Fetch balances if not loaded yet so a required opt-in is never skipped.
      if (optAsset === MUSD_ID) {
        let b = bal;
        if (!b && algodClient) b = await getBalances(algodClient, address, pool.lpAsaId);
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

  // Local clock so the live interest estimate visibly progresses without any network call.
  // 60s is pure client-side math (no RPC); interest on a loan barely moves in a minute.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

  // ── position math ──
  // Live-projected accrued interest — the stored field is lazy (only written on a vault
  // interaction), so we project it client-side. Skip in vault_state 2 where the contract
  // repurposes accrued_interest as a settlement counter.
  const liveInterest = pos && pos.vaultState !== 2
    ? projectedAccruedInterest(pos.accruedInterest, pos.musdBorrowed, pos.rateBps, pos.lastAccrualTs, nowSec)
    : (pos?.accruedInterest ?? 0);
  const posValue = pos ? pos.lpAmount * price : 0;
  const posDebt = pos ? pos.musdBorrowed + liveInterest : 0;
  const posHf = pos ? healthFactor(posValue, posDebt, vt.liqThresholdBps) : Infinity;

  return (
    <Panel className="p-6">
      {/* Header bar — one container per vault: title + key metrics, no subtext */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <PairGlyph tokens={vt.tokens} />
          <h2 className="font-display text-lg font-semibold text-white sm:text-xl">
            {`$${vt.tokens[0]}/ $${vt.tokens[1]} LP Collateral Vault`}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <HeaderMetric label="Interest rate" value={`${pct(vt.rateBps)}%`} />
          <HeaderMetric label="LTV ratio" value={`${pct(vt.ltvBps)}%`} />
          <HeaderMetric
            label="LP price"
            value={PROTOCOL_LIVE ? (oracle ? `$${formatUsd(price, 4)}` : "…") : "Soon"}
            sub={oracle ? (fresh ? "oracle fresh" : "oracle stale") : undefined}
            subClass={fresh ? "text-green-400" : "text-red-400"}
          />
        </div>
      </div>

      <div className="my-6 border-t border-white/10" />

      {/* Existing position */}
      {PROTOCOL_LIVE && pos && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Your position</p>
            <button onClick={refresh} className="text-gray-500 hover:text-white"><RefreshCw className="h-3.5 w-3.5" /></button>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Collateral</p>
              <p className="mt-1 font-mono text-white">{formatUsd(pos.lpAmount)} LP</p>
              <p className="text-xs text-gray-500">${formatUsd(posValue)}</p></div>
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Borrowed</p>
              <p className="mt-1 font-mono text-white">{formatUsd(pos.musdBorrowed)}</p></div>
            {pos.vaultState === 2 ? (
              <div><p className="text-[11px] uppercase tracking-wider text-gray-500">In settlement</p>
                <p className="mt-1 font-mono text-white">{formatUsd(pos.accruedInterest, 4)}</p>
                <p className="text-[11px] text-gray-500">remaining</p></div>
            ) : (
              <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Accrued interest (est.)</p>
                <p className="mt-1 font-mono text-white">{formatUsd(liveInterest, 4)}</p>
                <p className="text-[11px] text-gray-500">@ {pct(pos.rateBps)}% APR</p></div>
            )}
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Health factor</p>
              <p className={`mt-1 font-mono font-bold ${hfColor(posHf)}`}>{posHf === Infinity ? "∞" : posHf.toFixed(2)}</p></div>
          </div>
          {pos.vaultState !== 2 && posDebt > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="uppercase tracking-wider text-gray-500">Liquidation buffer</span>
                <span className="font-mono text-gray-400">{formatUsd(Math.min(100, liquidationBuffer(posValue, posDebt, vt.liqThresholdBps) * 100), 1)}% price drop to liquidation</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className={`h-full rounded-full transition-all ${posHf >= 1.5 ? "bg-green-400" : posHf >= 1.15 ? "bg-yellow-400" : "bg-red-400"}`}
                  style={{ width: `${Math.max(4, Math.min(100, liquidationBuffer(posValue, posDebt, vt.liqThresholdBps) * 100))}%` }} />
              </div>
            </div>
          )}
          {pos.vaultState === 2 && (
            <p className="mt-3 text-xs text-red-400">In liquidation — borrower actions are paused until settlement completes.</p>
          )}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <ManageAction id="pay" label="Pay interest" unit="mUSD" maxFill={liveInterest > 0 ? liveInterest * 1.01 + 0.001 : 0} onRun={(v) => payInterest(algorand!, address!, v, pool)} m={m} setM={setM} run={run} busy={busy} />
            <ManageAction id="repay" label="Repay / close" unit="mUSD" max={pos.musdBorrowed} maxFill={pos.musdBorrowed} onRun={(v) => repayPrincipal(algorand!, address!, v, pool)} m={m} setM={setM} run={run} busy={busy} />
            <ManageAction id="borrow" label="Borrow more" unit="mUSD" onRun={(v) => borrowMore(algorand!, address!, v, pool)} m={m} setM={setM} run={run} busy={busy} />
            <ManageAction id="add" label="Add collateral" unit="LP" onRun={(v) => addCollateral(algorand!, address!, v, pool)} m={m} setM={setM} run={run} busy={busy} />
          </div>
          <p className="mt-3 text-[11px] text-gray-600">Tip: “Repay / close” clears accrued interest automatically — enter your full borrowed amount to close the vault and reclaim your LP.</p>
        </div>
      )}

      {/* Open new vault */}
      {PROTOCOL_LIVE && !pos && (
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
                <div className={`flex items-center rounded-xl border bg-black/40 px-4 ${overCap ? "border-yellow-500/60" : "border-white/10 focus-within:border-magnet-500/50"}`}>
                  <input type="number" min={0} value={borrow} onChange={(e) => setBorrow(e.target.value)}
                    className="w-full bg-transparent px-1 py-3 font-mono text-lg text-white outline-none" placeholder="0" />
                  <span className="text-xs text-gray-500">mUSD</span>
                </div>
                {overCap ? (
                  <p className="mt-1.5 text-xs text-yellow-400/90">
                    Exceeds max borrow — capped at {formatUsd(cap, 0)} ({pct(vt.ltvBps)}% LTV). The health factor and Open use the capped amount.
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-gray-500">{pct(vt.ltvBps)}% max LTV</p>
                )}
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-white/5 bg-black/20 p-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Health factor</span>
                <span className={`font-mono text-2xl font-bold ${hfColor(openHf)}`}>{openHf === Infinity ? "∞" : openHf.toFixed(2)}</span>
              </div>
              {borrowAmt > 0 && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div className={`h-full rounded-full transition-all ${openHf >= 1.5 ? "bg-green-400" : openHf >= 1.15 ? "bg-yellow-400" : "bg-red-400"}`}
                    style={{ width: `${Math.max(4, Math.min(100, liquidationBuffer(collateralUsd, borrowAmt, vt.liqThresholdBps) * 100))}%` }} />
                </div>
              )}
              <div className="flex items-center justify-between border-t border-white/5 pt-3 text-sm">
                <span className="text-gray-400">Liquidation buffer</span>
                <span className="font-mono text-white">{borrowAmt > 0 ? `${formatUsd(liquidationBuffer(collateralUsd, borrowAmt, vt.liqThresholdBps) * 100, 1)}% drop` : "—"}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Interest / year</span>
                <span className="font-mono text-white">{formatUsd(borrowAmt * (vt.rateBps / 10_000))} mUSD ({pct(vt.rateBps)}%)</span>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-white/5 bg-black/30 px-3 py-2.5">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-magnet-400" />
                <p className="text-xs leading-relaxed text-gray-500">Liquidation starts below a 1.00 health factor. Repay or add collateral to stay above it.</p>
              </div>
              <PrimaryButton
                onClick={() => run("open", () => openVault(algorand!, address!, lpAmt, borrowAmt, pool), borrowAmt > 0 ? MUSD_ID : undefined)}
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
      )}
    </Panel>
  );
}

export function VaultsTab() {
  if (!PROTOCOL_LIVE) {
    return (
      <Panel className="p-10"><p className="text-center text-sm text-gray-400">Vaults open once the contracts are live.</p></Panel>
    );
  }
  return (
    <div className="space-y-10">
      {LIVE_VAULTS.map(({ vt, pool }) => (
        <VaultPanel key={vt.id} vt={vt} pool={pool} />
      ))}
    </div>
  );
}
