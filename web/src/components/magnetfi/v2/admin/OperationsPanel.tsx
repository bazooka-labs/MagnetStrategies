"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, AlertTriangle } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { ACTIVE } from "@/lib/magnetfi";
import * as ops from "@/lib/magnetfiOps";
import { Panel } from "../shared";

const LS_OPS = "magnetfi_ops_v1";
const LS_DEPLOY = "magnetfi_deploy_v1";

type Cfg = { oracle: string; psm: string; vault: string; musd: string; usdc: string };

function loadCfg(): Cfg {
  const base: Cfg = {
    oracle: ACTIVE.oracle ? String(ACTIVE.oracle) : "",
    psm: ACTIVE.psm ? String(ACTIVE.psm) : "",
    vault: ACTIVE.vault ? String(ACTIVE.vault) : "",
    musd: ACTIVE.musd ? String(ACTIVE.musd) : "",
    usdc: ACTIVE.usdc ? String(ACTIVE.usdc) : "",
  };
  if (typeof window === "undefined") return base;
  try {
    const saved = localStorage.getItem(LS_OPS);
    if (saved) return { ...base, ...JSON.parse(saved) };
    // Fall back to the deploy wizard's recorded app IDs.
    const dep = localStorage.getItem(LS_DEPLOY);
    if (dep) {
      const ids = JSON.parse(dep).ids ?? {};
      return { ...base, oracle: ids.oracle ?? base.oracle, psm: ids.psm ?? base.psm, vault: ids.vault ?? base.vault };
    }
  } catch { /* ignore */ }
  return base;
}

type Field = { key: string; label: string; placeholder?: string };

function ActionForm({
  title, desc, fields, button, tone = "default", onRun,
}: {
  title: string; desc: string; fields: Field[]; button: string;
  tone?: "default" | "danger" | "warn";
  onRun: (v: Record<string, string>) => Promise<void>;
}) {
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ready = fields.every((f) => (v[f.key] ?? "").trim() !== "");

  const btn =
    tone === "danger" ? "from-red-600 to-red-500"
    : tone === "warn" ? "from-yellow-600 to-yellow-500"
    : "from-magnet-600 to-magnet-500";

  return (
    <div className="rounded-xl border border-white/5 bg-black/20 p-4">
      <p className="text-sm font-medium text-white">{title}</p>
      <p className="mt-0.5 text-xs text-gray-500">{desc}</p>
      {fields.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {fields.map((f) => (
            <input
              key={f.key}
              value={v[f.key] ?? ""}
              onChange={(e) => setV((s) => ({ ...s, [f.key]: e.target.value }))}
              placeholder={f.placeholder ?? f.label}
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-magnet-500/50"
            />
          ))}
        </div>
      )}
      <button
        onClick={async () => {
          setBusy(true);
          try {
            await onRun(v);
            toast.success(`${title} ✓`);
            setV({});
          } catch (e) {
            const m = e instanceof Error ? e.message : "Transaction failed";
            toast.error(m.includes("rejected") ? "Signing cancelled" : m.slice(0, 140));
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy || !ready}
        className={`mt-3 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r ${btn} px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30`}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {button}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h4>
      <div className="grid gap-3 lg:grid-cols-2">{children}</div>
    </section>
  );
}

export function OperationsPanel() {
  const { address, algodClient, transactionSigner } = useWallet();
  const [cfg, setCfg] = useState<Cfg>(loadCfg);

  useEffect(() => { localStorage.setItem(LS_OPS, JSON.stringify(cfg)); }, [cfg]);

  const algorand = useMemo(
    () => (algodClient && transactionSigner ? ops.makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner],
  );

  const ready = !!algorand && !!address && !!cfg.oracle && !!cfg.psm && !!cfg.vault;
  const a = () => algorand!;
  const me = () => address!;
  const oracle = () => BigInt(cfg.oracle);
  const psm = () => BigInt(cfg.psm);
  const vault = () => BigInt(cfg.vault);
  const musd = () => Number(cfg.musd);
  const usdc = () => Number(cfg.usdc);
  const base = (s: string) => BigInt(Math.round((Number(s) || 0) * 1_000_000));

  return (
    <div className="space-y-6">
      {/* App IDs + assets */}
      <Panel className="p-6">
        <p className="mb-3 text-sm font-semibold text-white">Target contracts &amp; assets</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {(["oracle", "psm", "vault"] as const).map((k) => (
            <div key={k}>
              <label className="mb-1 block text-xs font-medium capitalize text-gray-400">{k} app ID</label>
              <input
                value={cfg[k]}
                onChange={(e) => setCfg((c) => ({ ...c, [k]: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-magnet-500/50"
              />
            </div>
          ))}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">mUSD ASA ID</label>
            <input value={cfg.musd} onChange={(e) => setCfg((c) => ({ ...c, musd: e.target.value }))}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-magnet-500/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">USDC ASA ID</label>
            <input value={cfg.usdc} onChange={(e) => setCfg((c) => ({ ...c, usdc: e.target.value }))}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-magnet-500/50" />
          </div>
        </div>
        <p className="mt-2 text-[11px] text-gray-600">
          Prefilled from the deploy wizard / config. Edit if you&apos;re operating a different deployment.
        </p>
      </Panel>

      {!ready ? (
        <Panel className="p-6">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" />
            <p className="text-xs text-yellow-200/90">
              Enter the deployed Oracle, PSM, and Vault app IDs above (and connect the admin/guardian
              wallet) to enable operations.
            </p>
          </div>
        </Panel>
      ) : (
        <div className="space-y-8">
          {/* Emergency */}
          <Section title="Emergency — pause">
            <ActionForm title="Pause vault borrowing" desc="Halts open_vault (with borrow) + borrow_more. Admin or guardian."
              fields={[]} button="Pause vault" tone="warn" onRun={() => ops.pauseVault(a(), me(), vault())} />
            <ActionForm title="Unpause vault" desc="Resumes borrowing. Guardian only." fields={[]} button="Unpause vault"
              onRun={() => ops.unpauseVault(a(), me(), vault())} />
            <ActionForm title="Pause PSM mint" desc="Halts public mint_musd (redeem stays open). Admin or guardian."
              fields={[]} button="Pause PSM" tone="warn" onRun={() => ops.pausePsm(a(), me(), psm())} />
            <ActionForm title="Unpause PSM" desc="Resumes minting. Guardian only." fields={[]} button="Unpause PSM"
              onRun={() => ops.unpausePsm(a(), me(), psm())} />
          </Section>

          {/* Liquidations */}
          <Section title="Liquidations">
            <ActionForm title="Mark payment overdue" desc="Flag a vault past its 90-day window."
              fields={[{ key: "b", label: "Borrower address" }, { key: "p", label: "Pool ID" }]} button="Mark overdue"
              onRun={(v) => ops.markOverdue(a(), me(), vault(), v.b, BigInt(v.p))} />
            <ActionForm title="Micro-liquidation" desc="Seize interest + 5% after 90-day non-payment."
              fields={[{ key: "b", label: "Borrower" }, { key: "p", label: "Pool ID" }]} button="Trigger micro" tone="warn"
              onRun={(v) => ops.triggerMicro(a(), me(), vault(), v.b, BigInt(v.p))} />
            <ActionForm title="Partial liquidation" desc="Tier 1 (35%) or Tier 2 (60%) seizure."
              fields={[{ key: "b", label: "Borrower" }, { key: "p", label: "Pool ID" }, { key: "t", label: "Tier (1 or 2)" }]}
              button="Trigger partial" tone="warn"
              onRun={(v) => ops.triggerPartial(a(), me(), vault(), v.b, BigInt(v.p), BigInt(v.t))} />
            <ActionForm title="Full liquidation" desc="Seize all LP for HF < 0.85."
              fields={[{ key: "b", label: "Borrower" }, { key: "p", label: "Pool ID" }]} button="Trigger full" tone="danger"
              onRun={(v) => ops.triggerFull(a(), me(), vault(), v.b, BigInt(v.p))} />
            <ActionForm title="Settle liquidation" desc="Return mUSD to PSM (atomic). Amount in mUSD."
              fields={[{ key: "b", label: "Borrower" }, { key: "p", label: "Pool ID" }, { key: "m", label: "mUSD amount" }]}
              button="Settle"
              onRun={(v) => ops.settleLiquidation(a(), me(), vault(), psm(), v.b, BigInt(v.p), base(v.m), musd())} />
            <ActionForm title="Advance accrual" desc="Catch up interest on a dormant vault (call repeatedly)."
              fields={[{ key: "b", label: "Borrower" }, { key: "p", label: "Pool ID" }]} button="Advance"
              onRun={(v) => ops.advanceAccrual(a(), me(), vault(), v.b, BigInt(v.p))} />
          </Section>

          {/* Risk parameters */}
          <Section title="Risk parameters">
            <ActionForm title="Set interest rate" desc="Per pool. Max 3000 bps (30%). New vaults only."
              fields={[{ key: "p", label: "Pool ID" }, { key: "r", label: "Rate (bps)" }]} button="Set rate"
              onRun={(v) => ops.setRate(a(), me(), vault(), BigInt(v.p), BigInt(v.r))} />
            <ActionForm title="Set liquidation threshold" desc="Set BEFORE LTV. Must exceed LTV; ≤ 9000 bps."
              fields={[{ key: "p", label: "Pool ID" }, { key: "t", label: "Threshold (bps)" }]} button="Set threshold"
              onRun={(v) => ops.setLiqThreshold(a(), me(), vault(), BigInt(v.p), BigInt(v.t))} />
            <ActionForm title="Set LTV" desc="Must be below the liquidation threshold."
              fields={[{ key: "p", label: "Pool ID" }, { key: "l", label: "LTV (bps)" }]} button="Set LTV"
              onRun={(v) => ops.setLtv(a(), me(), vault(), BigInt(v.p), BigInt(v.l))} />
            <ActionForm title="Set LP ASA ID" desc="Register the LP token for a pool."
              fields={[{ key: "p", label: "Pool ID" }, { key: "lp", label: "LP ASA ID" }]} button="Set LP ASA"
              onRun={(v) => ops.setLpAsaId(a(), me(), vault(), BigInt(v.p), BigInt(v.lp))} />
          </Section>

          {/* Reserves & fees */}
          <Section title="Reserves & fees">
            <ActionForm title="Deposit USDC" desc="Adds reserve, opening vault ceiling. Amount in USDC."
              fields={[{ key: "u", label: "USDC amount" }]} button="Deposit"
              onRun={(v) => ops.depositUsdc(a(), me(), psm(), base(v.u), usdc())} />
            <ActionForm title="Withdraw USDC" desc="Excess only — guard blocks dipping below circulating mUSD."
              fields={[{ key: "u", label: "USDC amount" }]} button="Withdraw"
              onRun={(v) => ops.withdrawUsdc(a(), me(), psm(), base(v.u))} />
            <ActionForm title="Collect interest fees" desc="Sweep accumulated mUSD interest to admin." fields={[]} button="Collect fees"
              onRun={() => ops.collectFees(a(), me(), vault())} />
            <ActionForm title="Collect ALGO" desc="Sweep excess vault ALGO to admin. Amount in ALGO."
              fields={[{ key: "x", label: "ALGO amount" }]} button="Collect ALGO"
              onRun={(v) => ops.collectAlgo(a(), me(), vault(), base(v.x))} />
            <ActionForm title="Set redemption fee" desc="mUSD → USDC fee. Max 500 bps (5%)."
              fields={[{ key: "f", label: "Fee (bps)" }]} button="Set fee"
              onRun={(v) => ops.setRedeemFee(a(), me(), psm(), BigInt(v.f))} />
            <ActionForm title="Set treasury" desc="Destination for redemption fees."
              fields={[{ key: "t", label: "Treasury address" }]} button="Set treasury"
              onRun={(v) => ops.setTreasury(a(), me(), psm(), v.t)} />
          </Section>

          {/* Oracle */}
          <Section title="Oracle">
            <ActionForm title="Re-anchor price" desc="Follow a genuine large move (price as mUSD/LP)."
              fields={[{ key: "p", label: "Pool ID" }, { key: "pr", label: "Price (mUSD/LP)" }]} button="Set anchor"
              onRun={(v) => ops.setPriceAnchor(a(), me(), oracle(), BigInt(v.p), base(v.pr))} />
            <ActionForm title="Rotate bot key" desc="Authorize a new oracle bot wallet."
              fields={[{ key: "addr", label: "New bot address" }]} button="Set updater"
              onRun={(v) => ops.setAuthorizedUpdater(a(), me(), oracle(), v.addr)} />
            <ActionForm title="Add pool" desc="Register a new pool (price sets the ±25% anchor)."
              fields={[{ key: "p", label: "Pool ID" }, { key: "pr", label: "Initial price (mUSD/LP)" }]} button="Add pool"
              onRun={(v) => ops.addPool(a(), me(), oracle(), BigInt(v.p), base(v.pr))} />
            <ActionForm title="Remove pool" desc="Delist a pool. Ensure no open vaults first." fields={[{ key: "p", label: "Pool ID" }]}
              button="Remove pool" tone="warn" onRun={(v) => ops.removePool(a(), me(), oracle(), BigInt(v.p))} />
          </Section>

          {/* Governance */}
          <Section title="Governance — timelocked & rotation (advanced)">
            <ActionForm title="Propose LP oracle repoint" desc="Vault → new oracle. 48h timelock; guardian can cancel."
              fields={[{ key: "id", label: "New oracle app ID" }]} button="Propose" tone="warn"
              onRun={(v) => ops.proposeLpOracle(a(), me(), vault(), BigInt(v.id))} />
            <ActionForm title="Confirm LP oracle repoint" desc="After the 48h timelock elapses." fields={[]} button="Confirm" tone="warn"
              onRun={() => ops.confirmLpOracle(a(), me(), vault())} />
            <ActionForm title="Cancel LP oracle repoint" desc="Guardian veto. Cancels a queued change." fields={[]} button="Cancel"
              onRun={() => ops.cancelLpOracle(a(), me(), vault())} />
            <ActionForm title="Propose vault repoint (PSM)" desc="PSM → new vault. 48h timelock; guardian can cancel."
              fields={[{ key: "id", label: "New vault app ID" }]} button="Propose" tone="warn"
              onRun={(v) => ops.proposeVaultContract(a(), me(), psm(), BigInt(v.id))} />
            <ActionForm title="Confirm vault repoint (PSM)" desc="After the 48h timelock elapses." fields={[]} button="Confirm" tone="warn"
              onRun={() => ops.confirmVaultContract(a(), me(), psm())} />
            <ActionForm title="Cancel vault repoint (PSM)" desc="Guardian veto." fields={[]} button="Cancel"
              onRun={() => ops.cancelVaultContract(a(), me(), psm())} />
            <ActionForm title="Propose admin (vault)" desc="2-step rotation. Admin or guardian proposes."
              fields={[{ key: "addr", label: "New admin address" }]} button="Propose admin" tone="danger"
              onRun={(v) => ops.proposeAdmin(a(), me(), "vault", vault(), v.addr)} />
            <ActionForm title="Accept admin (vault)" desc="New admin accepts the rotation." fields={[]} button="Accept admin" tone="danger"
              onRun={() => ops.acceptAdmin(a(), me(), "vault", vault())} />
          </Section>

          <p className="text-[11px] text-gray-600">
            Note: admin/guardian rotation and timelocked repoints are also available on the PSM and Oracle via the
            same methods — the vault is shown here as the common case. Pauses, repoint-confirms, and rotation
            acceptances must be signed by the appropriate role (guardian for unpause / veto / accept).
          </p>
        </div>
      )}
    </div>
  );
}
