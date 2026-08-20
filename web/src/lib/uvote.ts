// ── UVote — frontend config + helpers ───────────────────────────────────────
// Advisory, founder-led token-locking governance over $U. Standalone contract
// (contracts/magnetdao/uvote/uvote.py), separate from MagnetFi. Admin gating and
// the deploy signer match the MagnetFi admin wallet.

import algosdk from "algosdk";
import { MAGNETFI_ADMIN_ADDRESS, U_TOKEN } from "./magnetfi";

// The Vote admin (create proposals, deploy, founder transfer) is the same wallet
// that gates the MagnetFi admin panel. On deploy this wallet becomes `founder`.
export const UVOTE_ADMIN_ADDRESS = MAGNETFI_ADMIN_ADDRESS;

export const MAGNET_ASA_ID = U_TOKEN.asaId;          // 3081853135
export const MAGNET_DECIMALS = U_TOKEN.decimals;     // 5
export const DECIMAL_FACTOR = 10 ** U_TOKEN.decimals; // 100_000 base units = 1 $U

const _NET: "mainnet" | "testnet" =
  process.env.NEXT_PUBLIC_ALGO_NETWORK === "testnet" ? "testnet" : "mainnet";
export const UVOTE_NETWORK = _NET;

// Live app id per network. 0 until deployed via the admin Deploy handshake — the
// admin pastes the printed App ID here and redeploys the site (mirrors MagnetFi).
const UVOTE_APP_IDS: Record<"mainnet" | "testnet", number> = {
  mainnet: 0,
  testnet: 0,
};
export const UVOTE_APP_ID = UVOTE_APP_IDS[_NET];
export const UVOTE_LIVE = UVOTE_APP_ID > 0;

// Mirrors the contract. Voters pre-fund their own vote-box MBR (audit L1).
export const VOTE_DURATION_SECONDS = 604_800;        // 7 days
export const VOTE_BOX_MBR = 26_900;                  // µALGO, exact per box layout
export const CONTRACT_FUND_AMOUNT = 400_000;         // µALGO app funding on deploy

// ── Proposal box layout (696 bytes, fixed offsets) ──────────────────────────
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
export interface UVoteProposal {
  id: number;
  question: string;
  choices: string[];     // 2–4 non-empty labels
  votes: number[];       // parallel to choices, total $U base units per choice
  startTime: number;     // unix seconds
  endTime: number;       // unix seconds
}

export interface UVoteRecord {
  proposalId: number;
  choice: number;        // 0..3
  lockedAmount: number;  // $U base units
}

// ── Box-name helpers ─────────────────────────────────────────────────────────
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
  // Box values fit well under 2^53 ($U supply is 7.5e10 base units), so Number is safe.
  const dv = new DataView(buf.buffer, buf.byteOffset + off, 8);
  return Number(dv.getBigUint64(0));
}

function txt(buf: Uint8Array, off: number, len: number): string {
  const raw = buf.slice(off, off + len);
  // strip trailing null padding
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  return new TextDecoder().decode(raw.slice(0, end));
}

export function decodeProposal(id: number, value: Uint8Array): UVoteProposal {
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
    question: txt(value, OFF.question, QUESTION_MAX),
    choices: allChoices.slice(0, numChoices),
    votes: allVotes.slice(0, numChoices),
    startTime: u64(value, OFF.start),
    endTime: u64(value, OFF.end),
  };
}

export function decodeVote(proposalId: number, value: Uint8Array): UVoteRecord {
  return {
    proposalId,
    choice: u64(value, VOTE_OFF.choice),
    lockedAmount: u64(value, VOTE_OFF.amount),
  };
}

// ── Display helpers ──────────────────────────────────────────────────────────
export const toU = (baseUnits: number): number => baseUnits / DECIMAL_FACTOR;

export const formatU = (baseUnits: number): string =>
  toU(baseUnits).toLocaleString(undefined, { maximumFractionDigits: 0 });

export const isActive = (p: UVoteProposal, now = Date.now() / 1000): boolean =>
  now >= p.startTime && now < p.endTime;

export const choiceLetter = (i: number): string => String.fromCharCode(65 + i);

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function totalVotes(p: UVoteProposal): number {
  return p.votes.reduce((a, b) => a + b, 0);
}

/** Winning choice index by weight (−1 if no votes). */
export function leadingChoice(p: UVoteProposal): number {
  if (totalVotes(p) === 0) return -1;
  let best = 0;
  for (let i = 1; i < p.votes.length; i++) if (p.votes[i] > p.votes[best]) best = i;
  return best;
}
