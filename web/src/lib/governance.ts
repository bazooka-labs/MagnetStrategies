// ── Governance — frontend config, box layout, decoders ──────────────────────
//
// Advisory, founder-led token-locking votes. The founder posts a question; a
// holder signals by locking whole tokens for the 7-day window and reclaims them
// in full once it closes. Nothing on-chain executes on the result.
//
// ── Two eras, and why this file knows about both ────────────────────────────
// Voting moved from $U to mUSD on 2026-11-05. That is a NEW CONTRACT, not a
// reconfigured one — `musd_asa_id` is set at creation and has no setter, which
// is the property that stops an app's locked balance and its recorded debts
// from ever disagreeing. So UVote (App 3679681107, $U) is retired and mVote
// (mUSD) takes over.
//
// The retired app stays readable, because its one closed proposal is the only
// voting history the protocol has and deleting history to simplify a type is a
// bad trade. It is NOT writable: `accepting: false` keeps every vote and
// create path off it.
//
// Retiring it strands nobody — measured against mainnet 2026-11-05, App
// 3679681107 holds 0 $U with 0 outstanding vote boxes, and its proposal closed
// 2026-08-27. The claim path is kept pointed at it anyway (see
// governanceClient.ts), because "we measured zero" is a fact about one moment
// and a stranded voter is forever.
//
// ── The reason an era is carried on every proposal ──────────────────────────
// A UVote tally is denominated in $U at 5 decimals; an mVote tally is mUSD at
// 6. They are the same bytes in the same box offsets and they mean different
// things. If the unit came from app config instead of from the proposal, the
// legacy proposal's "35" would render as "35 mUSD" on a page about mUSD — a
// wrong number on screen, stated confidently. Carrying the era makes that
// unrepresentable rather than merely avoided.

import algosdk from "algosdk";
import { MAGNETFI_ADMIN_ADDRESS, MUSD, MUSD_ASA_ID, U_TOKEN, ACTIVE } from "./magnetfi";

/** The governance admin is the MagnetFi admin; on deploy it becomes `founder`. */
export const GOVERNANCE_ADMIN_ADDRESS = MAGNETFI_ADMIN_ADDRESS;

const _NET: "mainnet" | "testnet" =
  process.env.NEXT_PUBLIC_ALGO_NETWORK === "testnet" ? "testnet" : "mainnet";
export const GOVERNANCE_NETWORK = _NET;

export interface GovernanceEra {
  /** Stable id, used in React keys and to pick the right claim path. */
  key: "mvote" | "uvote";
  /** Display name of the contract generation. */
  name: string;
  appId: number;
  asaId: number;
  decimals: number;
  /** Unit shown beside every weight from this era. */
  unit: string;
  /**
   * This generation has been replaced by a later one.
   *
   * Distinct from undeployed, and the distinction is user-visible: both states
   * refuse a vote, but "retired" and "not shipped yet" are different sentences
   * to put in front of someone. Conflating them had mVote reporting itself
   * retired before it had ever been deployed.
   */
  retired: boolean;
  /**
   * Deployed AND not retired — the only state that takes new proposals and
   * votes. Derived rather than set by hand so the two cannot disagree.
   */
  accepting: boolean;
}

// 0 until the wallet-signed deploy handshake has run. The admin pastes the
// printed App ID here and redeploys the site — same pattern UVote used, which
// keeps the deployer's seed phrase out of every script and terminal.
const MVOTE_APP_IDS: Record<"mainnet" | "testnet", number> = {
  mainnet: 0,
  testnet: 0,
};

export const MVOTE: GovernanceEra = {
  key: "mvote",
  name: "mVote",
  appId: MVOTE_APP_IDS[_NET],
  asaId: _NET === "mainnet" ? MUSD_ASA_ID : ACTIVE.musd,
  decimals: MUSD.decimals,          // 6
  unit: MUSD.ticker,                // "mUSD"
  retired: false,
  accepting: MVOTE_APP_IDS[_NET] > 0,
};

export const UVOTE_RETIRED: GovernanceEra = {
  key: "uvote",
  name: "UVote",
  // Mainnet only. There was never a testnet UVote, and inventing one here would
  // make the testnet build read boxes from an app that does not exist.
  appId: _NET === "mainnet" ? 3679681107 : 0,
  asaId: U_TOKEN.asaId,
  decimals: U_TOKEN.decimals,       // 5
  unit: U_TOKEN.ticker,             // "$U"
  retired: true,
  accepting: false,
};

/** Newest era first — the order history is read and displayed in. */
export const GOVERNANCE_ERAS: GovernanceEra[] = [MVOTE, UVOTE_RETIRED]
  .filter((e) => e.appId > 0);

/** True once mVote is deployed and the page can offer a vote. */
export const GOVERNANCE_LIVE = MVOTE.accepting;

// Magnet Strategies treasury wallet — the USDC pool proposals direct.
export const TREASURY_ADDRESS = "VM2JLZMKFLE635FXX54MU4TY6JUDIMLNRXOQDZUX3FKUFLS2BPEO2VL7QM";
export const USDC_ASA_ID = ACTIVE.usdc;
const USDC_DECIMALS = 6;
export const formatUsdc = (baseUnits: number): string =>
  (baseUnits / 10 ** USDC_DECIMALS).toLocaleString(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Mirrors the contract. Voters pre-fund their own vote-box MBR.
export const VOTE_DURATION_SECONDS = 604_800;        // 7 days
export const VOTE_BOX_MBR = 26_900;                  // µALGO, exact per box layout
export const CONTRACT_FUND_AMOUNT = 400_000;         // µALGO app funding on deploy

// ── Proposal box layout (696 bytes, fixed offsets) ──────────────────────────
// Identical in both eras — mVote changed the asset and the decimal factor, not
// the storage. One decoder serves both, which is why a legacy proposal can be
// read at all.
export const PROPOSAL_BOX_SIZE = 696;
const OFF = {
  start: 0, end: 8, votesA: 16, votesB: 24, votesC: 32, votesD: 40,
  numChoices: 48, question: 56, choiceA: 312, choiceB: 408, choiceC: 504, choiceD: 600,
} as const;
export const QUESTION_MAX = 256;
export const CHOICE_MAX = 96;

// Vote box layout (16 bytes): [0:8] choice, [8:16] locked_amount
const VOTE_OFF = { choice: 0, amount: 8 } as const;

// ── Types ───────────────────────────────────────────────────────────────────
export interface Proposal {
  id: number;
  /** Which contract this came from. Everything that renders a weight needs it. */
  era: GovernanceEra;
  question: string;
  choices: string[];     // 2–4 non-empty labels
  votes: number[];       // parallel to choices, base units of `era.asaId`
  startTime: number;     // unix seconds
  endTime: number;       // unix seconds
}

export interface VoteRecord {
  proposalId: number;
  era: GovernanceEra;
  choice: number;        // 0..3
  lockedAmount: number;  // base units of `era.asaId`
}

// ── Box-name helpers ─────────────────────────────────────────────────────────
// The prefixes are 5 bytes in both eras, deliberately: VOTE_BOX_MBR above is
// derived from that length, so a longer prefix would silently change the exact
// payment the contract demands.
const enc = new TextEncoder();

export function propBoxName(proposalId: number): Uint8Array {
  return new Uint8Array([...enc.encode("prop_"), ...algosdk.encodeUint64(proposalId)]);
}

export function voteBoxName(proposalId: number, voter: string): Uint8Array {
  const pk = algosdk.decodeAddress(voter).publicKey;
  return new Uint8Array([...enc.encode("vote_"), ...algosdk.encodeUint64(proposalId), ...pk]);
}

// ── Decoders ─────────────────────────────────────────────────────────────────
function u64(buf: Uint8Array, off: number): number {
  // Safe as a Number: the largest representable tally is mUSD's total supply,
  // 5e14 base units, against 2^53 ≈ 9.007e15 — a factor of 18, so a little
  // over one order of magnitude. (This said "two orders of magnitude" and was
  // simply wrong; an audit caught it. The conclusion holds, the arithmetic
  // did not, and a wrong number in a comment justifying a safety claim is
  // exactly the kind that gets trusted later.)
  const dv = new DataView(buf.buffer, buf.byteOffset + off, 8);
  return Number(dv.getBigUint64(0));
}

function txt(buf: Uint8Array, off: number, len: number): string {
  const raw = buf.slice(off, off + len);
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;   // strip null padding
  return new TextDecoder().decode(raw.slice(0, end));
}

export function decodeProposal(era: GovernanceEra, id: number, value: Uint8Array): Proposal {
  const numChoices = u64(value, OFF.numChoices);
  const allChoices = [
    txt(value, OFF.choiceA, CHOICE_MAX),
    txt(value, OFF.choiceB, CHOICE_MAX),
    txt(value, OFF.choiceC, CHOICE_MAX),
    txt(value, OFF.choiceD, CHOICE_MAX),
  ];
  const allVotes = [
    u64(value, OFF.votesA), u64(value, OFF.votesB),
    u64(value, OFF.votesC), u64(value, OFF.votesD),
  ];
  return {
    id,
    era,
    question: txt(value, OFF.question, QUESTION_MAX),
    choices: allChoices.slice(0, numChoices),
    votes: allVotes.slice(0, numChoices),
    startTime: u64(value, OFF.start),
    endTime: u64(value, OFF.end),
  };
}

export function decodeVote(era: GovernanceEra, proposalId: number, value: Uint8Array): VoteRecord {
  return {
    proposalId,
    era,
    choice: u64(value, VOTE_OFF.choice),
    lockedAmount: u64(value, VOTE_OFF.amount),
  };
}

// ── Display helpers ──────────────────────────────────────────────────────────
// Each takes the era rather than reading a module constant, so a figure cannot
// be formatted with the wrong token's decimals or labelled with its ticker.
export const toWhole = (era: GovernanceEra, baseUnits: number): number =>
  baseUnits / 10 ** era.decimals;

export const formatWeight = (era: GovernanceEra, baseUnits: number): string =>
  toWhole(era, baseUnits).toLocaleString(undefined, { maximumFractionDigits: 0 });

/** The figure with its unit — the only form that should reach a page. */
export const formatWeightWithUnit = (era: GovernanceEra, baseUnits: number): string =>
  `${formatWeight(era, baseUnits)} ${era.unit}`;

export const isActive = (p: Proposal, now = Date.now() / 1000): boolean =>
  now >= p.startTime && now < p.endTime;

export const choiceLetter = (i: number): string => String.fromCharCode(65 + i);

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function totalVotes(p: Proposal): number {
  return p.votes.reduce((a, b) => a + b, 0);
}

/** Winning choice index by weight (−1 if no votes). */
export function leadingChoice(p: Proposal): number {
  if (totalVotes(p) === 0) return -1;
  let best = 0;
  for (let i = 1; i < p.votes.length; i++) if (p.votes[i] > p.votes[best]) best = i;
  return best;
}
