"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, AlertTriangle } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { ACTIVE, ACTIVE_ORACLE_POOLS } from "@/lib/magnetfi";
import { deployLeanOracle, configLeanOracle } from "@/lib/magnetfiDeploy";
import { getOracleHealth, getOracleRoles, type OracleRoles } from "@/lib/magnetfiReads";
import * as ops from "@/lib/magnetfiOps";
import { Panel } from "../shared";

const LS_OPS = "magnetfi_ops_v1";
const LS_DEPLOY = "magnetfi_deploy_v1";

type Cfg = { oracle: string; psm: string; vault: string; musd: string; usdc: string };

// The app IDs from the current deployment (ACTIVE) — the source of truth for what is actually live.
function deployedCfg(): Cfg {
  return {
    oracle: ACTIVE.oracle ? String(ACTIVE.oracle) : "",
    psm: ACTIVE.psm ? String(ACTIVE.psm) : "",
    vault: ACTIVE.vault ? String(ACTIVE.vault) : "",
    musd: ACTIVE.musd ? String(ACTIVE.musd) : "",
    usdc: ACTIVE.usdc ? String(ACTIVE.usdc) : "",
  };
}

function loadCfg(): Cfg {
  const base = deployedCfg();
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

type Field = { key: string; label: string; placeholder?: string; defaultValue?: string };

export function ActionForm({
  title, desc, fields, button, tone = "default", onRun,
}: {
  title: string; desc: string; fields: Field[]; button: string;
  tone?: "default" | "danger" | "warn";
  onRun: (v: Record<string, string>) => Promise<void>;
}) {
  // Defaults are read from chain by the caller, so a 58-char address is checked
  // rather than retyped. Keyed on the joined defaults so a late-arriving read
  // (they are fetched async) populates the inputs instead of being ignored.
  const defaults = fields.map((f) => f.defaultValue ?? "").join("|");
  const seed = () =>
    Object.fromEntries(fields.filter((f) => f.defaultValue).map((f) => [f.key, f.defaultValue!]));
  const [v, setV] = useState<Record<string, string>>(seed);
  useEffect(() => { setV(seed()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [defaults]);
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
            setV(seed());
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

export function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h4>
      <Panel className="p-4 sm:p-5">
        {note && <div className="mb-3 text-[11px] leading-relaxed text-white/40">{note}</div>}
        <div className="grid gap-3 lg:grid-cols-2">{children}</div>
      </Panel>
    </section>
  );
}

export function OperationsPanel() {
  const { address, algodClient, transactionSigner } = useWallet();
  const [cfg, setCfg] = useState<Cfg>(loadCfg);

  useEffect(() => { localStorage.setItem(LS_OPS, JSON.stringify(cfg)); }, [cfg]);

  // Surface — never silently override — any app ID that has drifted from the current deployment.
  // A stale saved ID (from before a redeploy) once caused a "pause" to hit a retired vault; this
  // makes the mismatch visible and offers a one-click reset, while leaving the admin in control
  // (editing IDs to operate a fresh deployment still works).
  // Read once for the migration forms' defaults; failure just leaves them blank.
  const [roles, setRoles] = useState<OracleRoles | null>(null);
  useEffect(() => {
    if (!algodClient) return;
    getOracleRoles(algodClient).then(setRoles).catch(() => setRoles(null));
  }, [algodClient]);

  const deployed = useMemo(() => deployedCfg(), []);
  const drift = (Object.keys(deployed) as (keyof Cfg)[]).filter(
    (k) => deployed[k] !== "" && cfg[k] !== "" && cfg[k] !== deployed[k],
  );
  const resetToDeployed = () => { setCfg(deployed); toast.success("Reset to deployed IDs"); };

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

        {drift.length > 0 && (
          <div className="mt-3 rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" />
              <div className="min-w-0 flex-1 text-xs text-yellow-100/90">
                <p className="font-semibold">Config differs from the current deployment.</p>
                <p className="mt-1">Actions will target the IDs above — <strong>not</strong> the deployed ones:</p>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] leading-relaxed">
                  {drift.map((k) => (
                    <li key={k}>
                      {k}: <span className="text-yellow-300">{cfg[k]}</span>{" "}
                      <span className="text-gray-500">→ deployed:</span>{" "}
                      <span className="text-green-300">{deployed[k]}</span>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={resetToDeployed}
                  className="mt-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px] font-semibold text-yellow-100 transition-colors hover:bg-yellow-500/20"
                >
                  Reset to deployed IDs
                </button>
              </div>
            </div>
          </div>
        )}
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
            <ActionForm title="Pause vault borrowing" desc={`Halts open_vault (with borrow) + borrow_more on vault ${cfg.vault}. Admin or guardian.`}
              fields={[]} button="Pause vault" tone="warn" onRun={() => ops.pauseVault(a(), me(), vault())} />
            <ActionForm title="Unpause vault" desc={`Resumes borrowing on vault ${cfg.vault}. Guardian only.`} fields={[]} button="Unpause vault"
              onRun={() => ops.unpauseVault(a(), me(), vault())} />
            <ActionForm title="Pause PSM mint" desc={`Halts public mint_musd on PSM ${cfg.psm} (redeem stays open). Admin or guardian.`}
              fields={[]} button="Pause PSM" tone="warn" onRun={() => ops.pausePsm(a(), me(), psm())} />
            <ActionForm title="Unpause PSM" desc={`Resumes minting on PSM ${cfg.psm}. Guardian only.`} fields={[]} button="Unpause PSM"
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
            <ActionForm title="Opt vault into LP token" desc="The vault must opt into an LP ASA before borrowers can deposit it. Run once per pool."
              fields={[{ key: "asa", label: "LP ASA ID" }]} button="Opt in"
              onRun={(v) => ops.optInAsset(a(), me(), "vault", vault(), BigInt(v.asa))} />
          </Section>

          {/* Reserves & fees */}
          <Section title="Reserves & fees">
            <ActionForm title="Deposit USDC" desc="Adds reserve, opening vault ceiling. Amount in USDC."
              fields={[{ key: "u", label: "USDC amount" }]} button="Deposit"
              onRun={(v) => ops.depositUsdc(a(), me(), psm(), base(v.u), usdc())} />
            <ActionForm title="Withdraw USDC" desc="Excess only — guard blocks dipping below circulating mUSD."
              fields={[{ key: "u", label: "USDC amount" }]} button="Withdraw" tone="warn"
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
          {/* These actions target the oracle that is DEPLOYED today — the banded
              one. Two of them exist only because it has a band, and both go away
              when the lean oracle is swapped in. They must NOT be removed before
              that: the banded oracle remains the vault's oracle for the whole 48h
              timelock, and "Re-anchor price" is the only remedy for a band
              rejection during it (STATUS.md §5). */}
          <Section
            title="Oracle"
            note={
              <>
                Targets the <strong className="text-white/60">banded</strong> oracle now live.{" "}
                <strong className="text-white/60">Re-anchor price</strong> exists only because that
                oracle has a ±25% band, and the anchor set by <strong className="text-white/60">Add
                pool</strong> is the same mechanism — both become meaningless once the lean oracle
                is swapped in, and neither is removed before then, because re-anchoring is the only
                way out of a band rejection during the 48h window.
              </>
            }
          >
            <ActionForm title="Re-anchor price" desc="Follow a genuine large move (price as mUSD/LP). Banded oracle only."
              fields={[{ key: "p", label: "Pool ID" }, { key: "pr", label: "Price (mUSD/LP)" }]} button="Set anchor"
              onRun={(v) => ops.setPriceAnchor(a(), me(), oracle(), BigInt(v.p), base(v.pr))} />
            <ActionForm title="Rotate bot key" desc="Authorize a new oracle bot wallet."
              fields={[{ key: "addr", label: "New bot address" }]} button="Set updater"
              onRun={(v) => ops.setAuthorizedUpdater(a(), me(), oracle(), v.addr)} />
            <ActionForm title="Add pool" desc="Register a new pool. On the banded oracle the price also sets the ±25% anchor; on the lean oracle it is only a seed."
              fields={[{ key: "p", label: "Pool ID" }, { key: "pr", label: "Initial price (mUSD/LP)" }]} button="Add pool"
              onRun={(v) => ops.addPool(a(), me(), oracle(), BigInt(v.p), base(v.pr))} />
            <ActionForm title="Remove pool" desc="Delist a pool. Ensure no open vaults first." fields={[{ key: "p", label: "Pool ID" }]}
              button="Remove pool" tone="warn" onRun={(v) => ops.removePool(a(), me(), oracle(), BigInt(v.p))} />
          </Section>

          {/* Governance */}
          {/* ORACLE_LEAN_SPEC.md §6 steps 1-3. Steps 4-5 are bot-side (a SECOND
              instance — never repoint the first), and step 6's propose/confirm
              already exist in Governance below. */}
          <Section
            title="Lean oracle migration — steps 1-3"
            note={
              <>
                Deploys the band-free oracle beside the live one and registers every pool on it.
                It does <strong className="text-white/60">not</strong> touch the vault — the vault
                keeps reading the banded oracle until <em>Confirm LP oracle repoint</em> in
                Governance below, 48h after the propose. Next, run a{" "}
                <strong className="text-white/60">second</strong> bot instance against the new
                oracle; repointing the existing one starves the oracle the vault is still using and
                freezes the protocol for the whole window.
              </>
            }
          >
            <ActionForm
              title="1. Deploy lean oracle"
              desc="Costs ~2.07 ALGO from your wallet for the app's global-state MBR (schema declared at the 19-pool ceiling). Guardian is prefilled from the live oracle."
              fields={[{ key: "g", label: "Guardian address", defaultValue: roles?.guardian ?? "" }]}
              button="Deploy"
              onRun={async (v) => {
                const id = await deployLeanOracle(a(), me(), v.g.trim());
                toast.success(`Lean oracle deployed — app ${id}. Paste it into step 2.`, { duration: 30_000 });
              }}
            />
            <ActionForm
              title="2+3. Authorize bot & register all pools"
              desc="One atomic group: set_authorized_updater plus add_pool for every pool, seeded from the LIVE prices. Refuses to run if any feed is stale — the seed is what existing positions are valued against the moment the vault switches."
              fields={[
                { key: "app", label: "Lean oracle app ID" },
                { key: "bot", label: "Bot address", defaultValue: roles?.authorizedUpdater ?? "" },
              ]}
              button="Authorize + register"
              tone="warn"
              onRun={async (v) => {
                const rows = await getOracleHealth(algodClient!);
                const stale = rows.filter((r) => r.ts === 0 || r.ageSec >= 1800).map((r) => r.id);
                if (stale.length) {
                  throw new Error(`Refusing: ${stale.join(", ")} stale. Seed from a live feed only.`);
                }
                if (rows.length !== ACTIVE_ORACLE_POOLS.length) {
                  throw new Error(`Expected ${ACTIVE_ORACLE_POOLS.length} pools, read ${rows.length}.`);
                }
                await configLeanOracle(
                  a(), me(), BigInt(v.app.trim()), v.bot.trim(),
                  rows.map((r) => ({ poolId: BigInt(r.poolId), price: BigInt(Math.round(r.price * 1e6)) })),
                );
              }}
            />
          </Section>

          <Section
            title="Governance — timelocked & rotation (advanced)"
            note={
              <>
                <strong className="text-white/60">Propose / Confirm LP oracle repoint</strong> is the
                lean-oracle migration. The PSM&nbsp;→&nbsp;vault repoint below is a different,
                heavier move: it is for replacing the <em>vault</em>, which has no repointing path,
                and forces every open position to be closed and reopened. It is not part of the
                oracle swap.
              </>
            }
          >
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
