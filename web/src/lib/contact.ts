// Contact / support inbox — reads + note schema (algosdk-free, browser-safe).
// No smart contract, no database: every "message" is a 0 ALGO payment transaction
// with a JSON payload in its note field, and a viewer's "inbox" is an Indexer query
// for transactions touching their own wallet address. Writes live in contactClient.ts.
//
// See the security notes on decodeNote() below before touching the trust boundary —
// this file is the one place that decides what counts as a genuine admin message.

import { INDEXER_URLS } from "./constants";
import { MAGNETFI_ADMIN_ADDRESS } from "./magnetfi";

// Reuses the same house wallet that already gates the MagnetFi admin panel — not a
// separate address. A compromised key here is the same compromise as MagnetFi's.
export const CONTACT_ADMIN_ADDRESS = MAGNETFI_ADMIN_ADDRESS;

export const NOTE_NS = "ms:";
export const MSG_MAX = 600;
export const NOTE_BYTE_LIMIT = 1000;
export const DEFAULT_CHANNEL = "updates";

export type NoteType = "support" | "reply" | "subscribe" | "unsubscribe" | "update";

const PREFIX: Record<NoteType, string> = {
  support: "ms:support:",
  reply: "ms:reply:",
  subscribe: "ms:subscribe:",
  unsubscribe: "ms:unsubscribe:",
  update: "ms:update:",
};

export type SupportApp = "Token" | "Bank" | "Farm" | "General";

export type ContactMessage =
  | { type: "support"; id: string; sender: string; round: number; roundTime: number; msg: string; txnId?: string; app?: SupportApp }
  | { type: "reply"; id: string; sender: string; receiver: string; round: number; roundTime: number; msg: string; thread: string }
  | { type: "subscribe"; id: string; sender: string; round: number; intraRoundOffset: number; channel: string }
  | { type: "unsubscribe"; id: string; sender: string; round: number; intraRoundOffset: number; channel: string }
  | { type: "update"; id: string; sender: string; receiver: string; round: number; roundTime: number; msg: string; channel: string };

export type Thread = {
  id: string;
  root: Extract<ContactMessage, { type: "support" }>;
  replies: Extract<ContactMessage, { type: "reply" }>[];
};

// ── base64 / utf8 helpers (browser-native; this feature runs client-side) ─────────

function utf8FromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function base64OfPrefix(prefix: string): string {
  // Prefixes are plain ASCII, so btoa alone is correct here.
  return btoa(prefix);
}

export function explorerTxUrl(id: string, network: "mainnet" | "testnet"): string {
  return network === "testnet" ? `https://testnet.algoexplorer.io/tx/${id}` : `https://algoexplorer.io/tx/${id}`;
}

// ── encode ──────────────────────────────────────────────────────────────────────

export function encodeNote(type: NoteType, payload: object): Uint8Array {
  const bytes = new TextEncoder().encode(PREFIX[type] + JSON.stringify(payload));
  if (bytes.length > NOTE_BYTE_LIMIT) {
    throw new Error("Message is too long to fit in a single transaction note.");
  }
  return bytes;
}

// ── decode ──────────────────────────────────────────────────────────────────────
// Minimal shape of what we read off an Indexer transaction (REST JSON).
type IndexerTxn = {
  id: string;
  sender: string;
  note?: string;
  "tx-type"?: string;
  "confirmed-round"?: number;
  "round-time"?: number;
  "intra-round-offset"?: number;
  "payment-transaction"?: { receiver?: string; amount?: number };
};

/**
 * Parses a raw Indexer transaction into a typed ContactMessage with NO trust
 * enforcement — it only validates shape (pay-type, known prefix, valid JSON,
 * required fields present). Used by fetchImpersonationAttempts(), which
 * specifically wants to see notes that *fail* the admin-sender check.
 * Everything else should use decodeNote() below, not this.
 */
export function decodeNoteRaw(txn: IndexerTxn): ContactMessage | null {
  if (txn["tx-type"] !== "pay") return null; // an ms: prefix on a non-payment txn is not a message
  if (!txn.note) return null;

  let raw: string;
  try {
    raw = utf8FromBase64(txn.note);
  } catch {
    return null;
  }
  if (!raw.startsWith(NOTE_NS)) return null;

  const entry = (Object.entries(PREFIX) as [NoteType, string][]).find(([, p]) => raw.startsWith(p));
  if (!entry) return null;
  const [type, prefix] = entry;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw.slice(prefix.length));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const id = txn.id;
  const sender = txn.sender;
  const round = txn["confirmed-round"] ?? 0;
  const roundTime = txn["round-time"] ?? 0;
  const intraRoundOffset = txn["intra-round-offset"] ?? 0;
  const receiver = txn["payment-transaction"]?.receiver;

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  switch (type) {
    case "support": {
      const msg = str(payload.msg);
      if (!msg) return null;
      const app = str(payload.app);
      return {
        type, id, sender, round, roundTime,
        msg: msg.slice(0, MSG_MAX),
        txnId: str(payload.txnId),
        app: (app === "Token" || app === "Bank" || app === "Farm" || app === "General") ? app : undefined,
      };
    }
    case "reply": {
      const msg = str(payload.msg);
      const thread = str(payload.thread);
      if (!msg || !thread || !receiver) return null;
      return { type, id, sender, receiver, round, roundTime, msg: msg.slice(0, MSG_MAX), thread };
    }
    case "subscribe":
    case "unsubscribe": {
      const channel = str(payload.channel);
      if (!channel) return null;
      return { type, id, sender, round, intraRoundOffset, channel };
    }
    case "update": {
      const msg = str(payload.msg);
      const channel = str(payload.channel);
      if (!msg || !channel || !receiver) return null;
      return { type, id, sender, receiver, round, roundTime, msg: msg.slice(0, MSG_MAX), channel };
    }
  }
}

/**
 * The safe default: parses like decodeNoteRaw(), then enforces the one rule that
 * actually protects users — a "reply" or "update" is only genuine if it was sent
 * by the real admin wallet. Anyone can construct a payment with an `ms:reply:` or
 * `ms:update:` note to any address; without this check that forged note would be
 * indistinguishable from a real admin message in the recipient's inbox. Forgeries
 * are discarded outright here, not flagged — the discard is the defense.
 */
export function decodeNote(txn: IndexerTxn): ContactMessage | null {
  const msg = decodeNoteRaw(txn);
  if (!msg) return null;
  if ((msg.type === "reply" || msg.type === "update") && msg.sender !== CONTACT_ADMIN_ADDRESS) {
    return null;
  }
  return msg;
}

// ── fetch ───────────────────────────────────────────────────────────────────────

async function fetchAllPages(url: string, params: URLSearchParams): Promise<IndexerTxn[]> {
  const out: IndexerTxn[] = [];
  let next: string | undefined;
  do {
    const p = new URLSearchParams(params);
    if (next) p.set("next", next);
    const res = await fetch(`${url}?${p}`);
    if (!res.ok) break;
    const data = await res.json();
    out.push(...((data.transactions ?? []) as IndexerTxn[]));
    next = data["next-token"] as string | undefined;
  } while (next);
  return out;
}

/** Every ms: message touching this wallet (sent or received), safely decoded. */
export async function fetchAccountContactMessages(
  address: string,
  network: "mainnet" | "testnet"
): Promise<ContactMessage[]> {
  try {
    const txns = await fetchAllPages(
      `${INDEXER_URLS[network]}/v2/accounts/${address}/transactions`,
      new URLSearchParams({ "note-prefix": base64OfPrefix(NOTE_NS), limit: "1000" })
    );
    const out: ContactMessage[] = [];
    for (const txn of txns) {
      try {
        const msg = decodeNote(txn);
        if (msg) out.push(msg);
      } catch {
        // malformed note — skip it, never let one bad transaction blank the batch
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Admin-only awareness view: an unscoped (non-address-filtered) search for reply/
 * update notes whose sender is NOT the real admin — i.e. impersonation attempts.
 * These never appear in the admin's normal inbox query (they're sent attacker →
 * victim, not attacker → admin), so without this the admin would have no way to
 * ever notice phishing is happening under the Magnet Strategies name. Best-effort
 * visibility only — the victim-side discard in decodeNote() is what protects users.
 */
export async function fetchImpersonationAttempts(
  network: "mainnet" | "testnet"
): Promise<ContactMessage[]> {
  const out: ContactMessage[] = [];
  for (const type of ["reply", "update"] as const) {
    try {
      const txns = await fetchAllPages(
        `${INDEXER_URLS[network]}/v2/transactions`,
        new URLSearchParams({ "note-prefix": base64OfPrefix(PREFIX[type]), limit: "1000" })
      );
      for (const txn of txns) {
        if (txn.sender === CONTACT_ADMIN_ADDRESS) continue;
        try {
          const msg = decodeNoteRaw(txn);
          if (msg) out.push(msg);
        } catch {
          // malformed — not our concern here, only genuine forgeries matter
        }
      }
    } catch {
      // network hiccup on one prefix shouldn't blank the other
    }
  }
  return out;
}

// ── derived views ───────────────────────────────────────────────────────────────

/** Groups support tickets with their replies into conversations, newest first. */
export function buildThreads(messages: ContactMessage[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const m of messages) {
    if (m.type === "support") threads.set(m.id, { id: m.id, root: m, replies: [] });
  }
  for (const m of messages) {
    if (m.type === "reply") threads.get(m.thread)?.replies.push(m);
  }
  const list = Array.from(threads.values());
  list.sort((a, b) => b.root.round - a.root.round);
  for (const t of list) t.replies.sort((a, b) => a.round - b.round);
  return list;
}

/** Current subscriber set: the chronologically-last subscribe/unsubscribe per sender wins. */
export function computeSubscribers(messages: ContactMessage[], channel = DEFAULT_CHANNEL): Set<string> {
  const latest = new Map<string, { subscribed: boolean; round: number; intraRoundOffset: number }>();
  for (const m of messages) {
    if (m.type !== "subscribe" && m.type !== "unsubscribe") continue;
    if (m.channel !== channel) continue;
    const prev = latest.get(m.sender);
    const isNewer = !prev || m.round > prev.round || (m.round === prev.round && m.intraRoundOffset > prev.intraRoundOffset);
    if (isNewer) latest.set(m.sender, { subscribed: m.type === "subscribe", round: m.round, intraRoundOffset: m.intraRoundOffset });
  }
  const subs = new Set<string>();
  for (const [addr, v] of latest) if (v.subscribed) subs.add(addr);
  return subs;
}
