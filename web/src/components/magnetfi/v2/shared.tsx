"use client";

import { type ReactNode } from "react";
import Image from "next/image";

// Real token icons (by unit name, "$" stripped). Tokens not listed fall back to a text chip.
// This is the $U *ASA* mark — used only for the token itself, never as the brand/nav logo.
const TOKEN_ICONS: Record<string, string> = {
  U: "/tokens/u.png",
  MUSD: "/musd-icon.png",
  TALGO: "/tokens/talgo.png",
  USDC: "/tokens/usdc.png",
  MOOJ: "/tokens/mooj.png",
  ALPHA: "/tokens/alpha.png",
  COMPX: "/tokens/compx.png",
  HAY: "/tokens/hay.png",
};
/** Real icon path for a token symbol ("$"/case-insensitive), or null for a text fallback. */
export const tokenIcon = (sym: string) => TOKEN_ICONS[sym.replace("$", "").toUpperCase()] ?? null;
// Wordmark-style art that should fit inside the chip rather than fill it.
const CONTAIN_ICONS = new Set(["ALPHA"]);
export const tokenIconFit = (sym: string) =>
  CONTAIN_ICONS.has(sym.replace("$", "").toUpperCase()) ? "object-contain" : "object-cover";

/** Glassy panel with the brand's top gradient hairline (matches the landing cards). */
export function Panel({
  children,
  className = "",
  glow = false,
}: {
  children: ReactNode;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/10 bg-black/40 backdrop-blur-sm shadow-xl shadow-black/40 ${
        glow ? "glow-blue" : ""
      } ${className}`}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
      {children}
    </div>
  );
}

export function SoonBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-magnet-500/30 bg-magnet-500/10 px-2.5 py-0.5 text-xs font-medium text-magnet-300">
      Coming soon
    </span>
  );
}

export function LaunchingBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-400">
      <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse-slow" />
      Launching first
    </span>
  );
}

/** A single token chip — real icon if we have one, else a text fallback. */
function TokenChip({ sym, variant, className = "" }: {
  sym: string; variant: "primary" | "secondary"; className?: string;
}) {
  const icon = tokenIcon(sym);
  const base = `flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 shadow-md ${className}`;
  if (icon) {
    return (
      <span className={`${base} overflow-hidden bg-black`}>
        <Image src={icon} alt={sym} width={36} height={36} className={`h-full w-full ${tokenIconFit(sym)}`} />
      </span>
    );
  }
  const fill = variant === "primary"
    ? "bg-gradient-to-br from-magnet-500 to-magnet-700 text-white"
    : "bg-surface-lighter text-gray-200";
  return <span className={`${base} ${fill} text-[10px] font-bold`}>{sym.replace("$", "")}</span>;
}

/** Two overlapping token chips representing an LP pair. */
export function PairGlyph({ tokens }: { tokens: [string, string] }) {
  return (
    <div className="flex shrink-0 items-center">
      <TokenChip sym={tokens[0]} variant="primary" className="z-10" />
      <TokenChip sym={tokens[1]} variant="secondary" className="-ml-3" />
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "purple";
}) {
  const valueColor =
    accent === "green" ? "text-green-400" : accent === "purple" ? "text-magnet-300" : "text-white";
  return (
    <Panel className="p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-bold ${valueColor}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </Panel>
  );
}

/** Primary gradient button, used across the v2 surfaces. */
export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-xl bg-gradient-to-r from-magnet-600 to-magnet-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-magnet-900/40 transition-all hover:from-magnet-500 hover:to-magnet-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:from-magnet-600 disabled:hover:to-magnet-500 ${className}`}
    >
      {children}
    </button>
  );
}

export function NotLiveNote() {
  return (
    <p className="mt-3 text-center text-xs text-gray-500">
      On-chain actions unlock when the v2 contracts go live on mainnet.
    </p>
  );
}
