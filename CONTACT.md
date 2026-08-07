# Magnet Strategies — Contact & Support

Users message the Magnet Strategies admin directly from `/contact`. Every message is an
Algorand transaction — no smart contract, no database. The transaction signature proves
wallet ownership; the Algorand Indexer is the inbox. Admin replies come back the same
way, and users can subscribe to a broadcast update channel.

This is the same zero-backend pattern as Golden Saddles Casino's support form
(`CONTACT.md` in `bazooka-labs/golden-saddles-casino`), extended to be **two-way**
(admin replies land back in the sender's inbox, not just a one-way ticket drop) and to
support a **subscribe/broadcast channel** on top.

---

## Architecture

```
User writes a message (+ optional txn ID, "related to" product, subscribe checkbox)
          ↓
Fields encoded into an Algorand transaction note: "ms:support:{JSON}"
          ↓
User signs and submits: 0 ALGO → Admin Wallet  (+ a grouped "ms:subscribe:" txn if checked)
          ↓
Transaction confirmed on-chain
          ↓
Anyone's "inbox" = Indexer query: transactions touching their own wallet, note-prefix "ms:"
          ↓
Decoded client-side, split by sub-prefix, support tickets grouped into threads by root txn ID
          ↓
Admin replies the same way: 0 ALGO → user's wallet, note "ms:reply:{JSON, thread: <root txn id>}"
          ↓
Admin broadcasts: one "ms:update:{JSON, bid: <broadcast id>}" payment per subscriber, chunked ≤16/group
          ↓
Admin sees per-broadcast delivery (updates grouped by bid) and can resend only to subscribers missing it
```

**Cost:** 0.001 ALGO (network fee only) per message, either direction. Subscribing adds
one more. **No Supabase, no edge functions, no smart contract — the Indexer is the
database**, same as GSC's version.

---

## Note Schema

Prefix namespace `ms:` (mirrors GSC's `gsc:` and this repo's existing
`magnet-apply:v1:` DAO-application convention). Every note is UTF-8 JSON, message
bodies capped at 600 characters, whole note kept under Algorand's 1000-byte limit.

| Prefix | Direction | Payload |
|---|---|---|
| `ms:support:` | user → admin (new ticket) | `{ msg, txnId?, app? }` — `app`: `"Token"` \| `"Bank"` \| `"Farm"` \| `"General"` |
| `ms:reply:` | admin → user | `{ msg, thread }` — `thread` = the root ticket's own txn ID |
| `ms:subscribe:` | user → admin | `{ channel }` — `channel: "updates"` (default channel; schema allows more later) |
| `ms:unsubscribe:` | user → admin | `{ channel }` |
| `ms:update:` | admin → each subscriber | `{ msg, channel, bid }` — `bid` = a broadcast id shared by every update txn in one broadcast (powers delivery tracking + resend) |

**Thread correlation:** a ticket's own transaction ID *is* the thread ID. Every reply
carries `thread` pointing back to it — a full conversation reconstructs client-side with
no server state.

**Subscriber set:** computed, not stored. Every `ms:subscribe:`/`ms:unsubscribe:`
transaction addressed to the admin wallet is scanned; the chronologically-last action
per sender address (sorted by confirmed-round, then intra-round offset) wins.

---

## Broadcast Delivery Tracking & Resend

Every update transaction in one broadcast carries the same **`bid`** (broadcast id —
`newBroadcastId()` in `lib/contact.ts`: `base36(now) + random`). The admin's own sent updates
come back in the admin's Indexer query, so `computeBroadcasts()` reconstructs each broadcast
client-side — `{ bid, msg, channel, roundTime, recipients: Set<address> }`, grouped by `bid`.
No server state: the chain itself records who received what.

The admin panel turns this into:
- **Per-broadcast delivery** — for each sent broadcast, `delivered / total current subscribers`,
  where `delivered = currentSubscribers ∩ recipients(bid)` (plus the raw total recipient count).
- **Resend to missing** — one action that computes `missing = currentSubscribers − recipients(bid)`
  and sends the *same* `bid` + `msg` only to those wallets. This is the recovery path for both a
  **partially-delivered broadcast** (session dropped / a signature rejected mid-batch) and wallets
  that **subscribed after** the original send. It never re-sends to a wallet already in
  `recipients`, and can't target a non-subscriber (missing is derived by filtering the current
  subscriber set). The admin panel refreshes after every send — including partial failures — so the
  delivered/missing counts always reflect what actually landed on-chain.

Only bid-tagged updates are tracked; legacy untagged broadcasts still deliver and render, they just
don't appear in the history. **`bid` is a grouping key only** — never used in any trust decision;
`decodeNote()`'s admin-sender verification is unchanged, so a forged update with a spoofed `bid`
can neither enter the admin's tracking nor appear in a victim's inbox.

---

## Query Pattern

Algorand Indexer's `.address(X)` matches transactions where X is **either** sender or
receiver — so one query per viewer returns everything relevant to them:

- **User inbox:** `GET /v2/accounts/{wallet}/transactions?note-prefix={base64("ms:")}`
  → their own sent tickets, replies received, their own subscribe actions, broadcasts
  received — all in one call, split client-side by sub-prefix.
- **Admin panel:** same call against the admin wallet → every incoming ticket, every
  reply the admin has sent, every subscribe/unsubscribe signal, every broadcast sent.

Uses the same `INDEXER_URLS` REST endpoints already used elsewhere in this repo
(`app/dao/proposals`, `app/dao/treasury`) — not algosdk's `Indexer` client class, which
exists in `lib/algorand.ts` but is unused dead code.

---

## Security Model

This is public, permissionless infrastructure: anyone can send a 0 ALGO payment with
any note content to any address for 0.001 ALGO. The design went through two adversarial
review passes before implementation — the following are load-bearing, not optional
hardening:

1. **Sender verification is mandatory.** An Indexer match alone (`address` +
   `note-prefix`) does not prove who sent a note. `decodeNote()`
   (`web/src/lib/contact.ts`) only accepts an `ms:reply:` or `ms:update:` note as
   genuine if `txn.sender === CONTACT_ADMIN_ADDRESS`; anything else is **discarded**,
   not flagged, before it ever reaches a render. Without this, anyone could pay 0.001
   ALGO to send a victim a fake "message from Magnet Strategies" — e.g. a phishing
   note asking them to "verify" their wallet. This also closes thread-hijacking (an
   attacker setting `thread` to a real ticket's txn ID to inject a fake reply), since
   a forged reply is discarded regardless of what `thread` value it claims.
2. **No confidentiality, and the UI says so.** `ms:support:` tickets are public
   on-chain data — anyone can run the same query the admin does. The Create and Inbox
   tabs both carry a persistent disclosure line (`SecurityNotice` in
   `components/contact/shared.tsx`).
3. **Plain text only.** Message bodies render as inert JSX text — no auto-linkified
   URLs, no markdown, no `dangerouslySetInnerHTML` anywhere in this feature. This
   directly closes the "malicious URL" concern: even a message that passes sender
   verification can't become a clickable phishing link. A persistent line also states
   Magnet Strategies will never ask for ALGO or a seed phrase "to verify" anything —
   a genuinely admin-signed message could still *say* that in plain text, and no
   rendering fix can stop social engineering, only a stated policy can.
4. **Defensive decoding.** Every note decode is wrapped so a malformed, non-JSON,
   truncated, or wrong-transaction-type (`decodeNoteRaw` explicitly checks
   `tx-type === "pay"` before reading payment fields) note is skipped individually —
   never allowed to throw and blank the whole batch for every other message in the
   same query result.
5. **Admin-side impersonation awareness.** A forged reply/update is sent
   attacker → victim, so it never touches the admin's own address and would otherwise
   be structurally invisible to the admin too. `fetchImpersonationAttempts()` runs an
   unscoped, non-address-filtered note-prefix search for `ms:reply:`/`ms:update:`
   notes where `sender !== CONTACT_ADMIN_ADDRESS`, surfaced in the Admin tab's
   "Impersonation attempts" panel — awareness only, not a defense (the victim-side
   discard in point 1 is what actually protects users).
6. **Shared admin-key blast radius, accepted explicitly.** `CONTACT_ADMIN_ADDRESS`
   reuses `MAGNETFI_ADMIN_ADDRESS` — the same wallet already gating MagnetFi's admin
   panel. Not a new vector this feature introduces, but this feature's integrity now
   depends on that key's existing operational security.
7. **Accepted, cost-bounded risks (not fixable without a contract):** ticket-flood
   spam and sybil `ms:subscribe:` wallets are bounded by the attacker's own fee
   spend — they degrade admin UX (noisier inbox, wasted broadcast fees to fake
   subscribers), never funds. **No fund-drain path exists anywhere**: every
   transaction in this feature is a 0 ALGO payment, no contract, no approvals, no
   escrow.

---

## Sending Transactions

All sends go through `AlgorandClient` (`@algorandfoundation/algokit-utils`), the same
convention as `magnetfiClient.ts`/`magnetfiOps.ts` elsewhere in this repo — not raw
`algosdk.Transaction` or manual `sendRawTransaction`.

```typescript
// web/src/lib/contactClient.ts
await al.newGroup()
  .addPayment({ sender, receiver: admin, amount: microAlgo(0), note: encodeNote("support", payload) })
  .send();
```

- **Ticket** (Create tab): one `ms:support:` payment; grouped with an `ms:subscribe:`
  payment if the checkbox is checked — one wallet signature covers both.
- **Admin reply:** one `ms:reply:` payment to the ticket's sender, `thread` = the
  ticket's own txn ID.
- **Admin broadcast:** one `ms:update:` payment (tagged with a shared `bid`) per current
  subscriber, batched in atomic groups of ≤16 (Algorand's group cap) — each chunk is one wallet
  signature. **Resend-to-missing** reuses the same `bid`/`msg` for only the current subscribers not
  yet in `recipients(bid)` (see Broadcast Delivery Tracking above). Known scaling ceiling for large
  subscriber counts (this is exactly the problem ConchShell's actual broadcast-escrow contract
  exists to solve at scale); acceptable for v1.

---

## Files

| File | Purpose |
|---|---|
| `web/src/lib/contact.ts` | Note schema, `encodeNote`/`decodeNote`/`decodeNoteRaw`, `fetchAccountContactMessages`, `fetchImpersonationAttempts`, `buildThreads`, `computeSubscribers`, `computeBroadcasts`, `newBroadcastId`, `explorerTxUrl` (allo.info / lora). Read-only + pure parsing, algosdk-free. |
| `web/src/lib/contactClient.ts` | Writes: `sendTicket`, `sendSubscription`, `sendReply`, `sendBroadcast` (stamps the `bid`), `makeAlgorand`. Mirrors the reads/writes split already used for MagnetFi. |
| `web/src/app/contact/layout.tsx` | Route metadata + shared Navbar/Footer, matches `app/magnetfi/layout.tsx`. |
| `web/src/app/contact/page.tsx` | Hero, "How this works" mechanics overview, Create/Inbox/Admin tab bar. |
| `web/src/components/contact/CreateTab.tsx` | Compose form: message, optional txn ID, "related to" product select, subscribe checkbox, send + confirmation. |
| `web/src/components/contact/InboxTab.tsx` | Wallet-gated inbox: threads (ticket + replies) and a separate Announcements section for broadcasts received. |
| `web/src/components/contact/AdminTab.tsx` | Gated to `CONTACT_ADMIN_ADDRESS`: ticket list + inline reply composer; prominent subscriber-count stat + broadcast composer; **Sent-broadcasts history** with per-broadcast delivered/total + **Resend to missing**; impersonation-attempts panel. |
| `web/src/components/contact/SubscribeButton.tsx` | One-tap opt-in to the update channel (used on `/about`); errors if no wallet is connected. |
| `web/src/components/contact/shared.tsx` | `SecurityNotice` (persistent disclosure/anti-phishing line), `formatTimestamp`, `APP_OPTIONS`. |
| `web/src/components/Navbar.tsx` | "Contact" added to the header nav (`navLinks`). |
| `web/src/app/about/page.tsx` | Carries the `SubscribeButton` so new visitors can opt into updates while learning about Magnet Strategies. |

`CONTACT_ADMIN_ADDRESS` (in `lib/contact.ts`) reuses the existing
`MAGNETFI_ADMIN_ADDRESS` from `lib/magnetfi.ts` — the same house wallet, not a separate
address. Trivial to point elsewhere later since it's one constant.

---

## Differences from Golden Saddles Casino's Version

GSC's `CONTACT.md` describes a **one-way** system: player submits, admin reads and acts
(REFUND/CLAIM) from the casino's own game state — there is no reply channel back to the
player. Magnet Strategies extends the identical zero-backend mechanic to be two-way
(`ms:reply:`) and adds a broadcast channel (`ms:subscribe:`/`ms:update:`), which is why
the sender-verification requirement above exists: GSC never needed it, because nothing
in GSC's one-way flow is ever rendered to a user as "a message from the admin." The
moment a reply/broadcast channel exists, forgeable "from admin" content becomes
possible, and discarding unverified senders is what closes it.

## Future Idea (not started)

The founder has floated extracting this note-based messaging pattern (encode a JSON
payload into a transaction note, Indexer-as-database, sender-verified replies) into a
shared package reusable across Magnet Strategies, ConchShell, and Golden Saddles
Casino — all three have independently hand-rolled variations of it. Discussed
2026-08-03, intentionally deferred to a separate initiative, not part of this build.
