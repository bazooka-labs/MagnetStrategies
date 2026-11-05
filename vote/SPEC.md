# Governance — Build Spec

Two generations. **mVote** (mUSD) is current; **UVote** ($U, App `3679681107`)
is retired and kept below because its audit history is the reason mVote looks
the way it does.

---

# mVote — mUSD-weighted voting

_Status: written, proven on a local AVM, audited by three independent passes.
**Not yet deployed.** `MVOTE_APP_IDS` is 0._
_Last updated: 2026-11-05_

## What it is

UVote with the voting asset changed from $U to mUSD, and nothing else changed
that did not have to be. That is the design: UVote's logic has two independent
adversarial audits behind it, the second one after deploy and against the
deployed bytes. Replicating preserves that confidence; rewriting spends it.

Contract: `contracts/mvote/mvote/mvote.py` (PyTeal v8).
Frontend: `web/src/lib/governance*.ts`.

## The diff from UVote, in full

Compile both and diff the TEAL — it is the only description of this contract
that cannot drift. The changes are:

| # | Change | Why |
|---|---|---|
| — | `magnet_asa_id` → `musd_asa_id` (4 sites) | Set at creation, no setter, as before. An app that can be repointed is an app whose locked balance and recorded debts can disagree. |
| — | `DECIMAL_FACTOR` 10^5 → 10^6 | $U has 5 decimals, mUSD has 6. Read off the chain, not inferred. Minimum vote goes from ~$0.15 to $1.00. |
| I-1 | `claim_tokens` asserts `Global.group_size() == 1` | UVote's post-deploy re-audit filed this as "future redeploy only". Costs nothing: the UI has one claim button per card, so batching was never offered. |
| I-2 | `create_proposal` uses checked `BoxCreate(...) == 1` | Was safe only via monotonic `proposal_count`. Now self-evident. |
| I-3 | `claim_tokens` asserts `BoxDelete(...) == 1` | Found while writing. A 0 would have run both inner transfers while the vote box survived to be claimed again. The re-entrancy argument rests on that delete having happened. |
| I-4 | `cast_vote` group reordered to `[0]` payment, `[1]` transfer, `[2]` app call | **Removes a standing-funding requirement neither UVote audit could close.** See below. |

## I-4: why the group order matters

Algorand checks an account's minimum balance **at the end of each transaction**,
not at the end of the group. With the app call first it created the vote box —
raising the app's minimum by 26,900 µALGO — while the payment covering that was
still two transactions away. So the app had to carry a permanent 26,900 buffer
or the *first vote of every deployment* reverted. UVote's audit filed it as
deploy requirement L1: "required, not optional", and the live app is immutable
so it could never be fixed there.

Moving the payment ahead of the app call means the ALGO has landed before the
box exists. Measured, not reasoned: an app funded to **exactly** its minimum
balance, zero spare, now accepts its first vote. Under the old order the same
app rejected it with `balance 486100 below min 513000`.
`test_mvote_localnet.py::zero_buffer_vote` is that case, and it goes red if
anyone resequences the group.

Every assert is unchanged — only its index moved. Each transaction is still
pinned by type, sender, receiver, amount and asset, so position was never what
made the group safe.

## Transaction shapes

- **create_proposal** (founder): group of 2 — `[0]` Payment `286,100 µALGO`
  (proposal-box MBR), `[1]` AppCall `[create_proposal, question, a, b, c, d]`.
  Limits are **bytes**, not characters: 256 for the question, 96 per choice.
- **cast_vote** (voter): group of 3 — `[0]` Payment `26,900 µALGO`,
  `[1]` AXFER whole mUSD → app, `[2]` AppCall `[cast_vote, id8, choice8]`.
- **claim_tokens** (voter, after close): AppCall `[claim_tokens, id8]`, **alone**
  (`group_size == 1`), outer `flat_fee=true, fee=3000` for two inner txns.

Box layout, global state and MBR arithmetic are unchanged from UVote — see the
UVote spec below, which remains accurate for all of it.

## How it was proven

- `test_mvote_localnet.py` — 28 assertions, real signatures on a real AVM.
  Localnet rather than testnet because dev mode can shift block timestamps, so
  the 7-day window is actually crossed; everything about post-close behaviour is
  otherwise untestable without waiting a week.
- `mutate_mvote.py` — deletes each guard and requires the matching test to flip.
  10 caught, 1 documented-redundant, 0 survivors. It found one vacuous test,
  where "claim before the window closes" passed with the window check deleted
  because the voter had not voted yet.
- `check_musd_asset.py` — re-measures the asset assumption fund safety rests on:
  mUSD has no clawback and no freeze, and on Algorand neither can ever be added.
- `verify_embedded.py` — the bytes the deploy button ships are this contract
  compiled. The toolchain was itself validated by compiling UVote with it and
  matching the deployed app byte-for-byte.

## Audit, 2026-11-05 (three independent agents, cold context)

No Critical, no High. No fund-loss path, no tally-manipulation path, no figure
rendered with the wrong token's decimals.

- **Contract** — all seven attack categories clean except the funding liveness
  issue, which became I-4 above rather than a documented workaround.
- **Frontend** — found a class of defect where a failed read rendered as a
  confident fact: a rate-limited node turned a live proposal into "Nothing to
  vote on", a failed box read **hid the Reclaim button from a voter with locked
  funds**, and a failed account read told a 5,000 mUSD wallet it needed 1 mUSD
  to vote. All fixed; `governanceUnknowns.test.ts` guards them.
- **Migration/ops** — found that a half-finished deploy lost the App ID and that
  the two-step founder transfer had no UI. Both fixed.

## Known and accepted

- **No founder sweep path.** The contract holds exactly the sum of locked mUSD
  and the only exit is a voter reclaiming their own recorded amount. The cost:
  mUSD sent to the app by mistake is stuck forever, and mUSD is worth a dollar.
  There is no path that distinguishes a donation from a lock without also being
  a path that moves tokens the contract does not owe.
- **No proposal cancel.** A typo'd proposal blocks the next one for 7 days.
  Voters still reclaim; a new proposal follows.
- **Each proposal permanently costs 0.2861 ALGO** of app minimum balance, since
  proposal boxes are never deleted. ~15 ALGO/year at one proposal a week.
- **Founder key loss halts governance.** Voters can still reclaim. A successor
  needs a new app and a new era entry in `governance.ts`.
- **Sybil and last-second voting** are inherent to advisory token locking.
  Weight is locked mUSD, and the founder writes the question.

---

# UVote — Build Spec (v2 voting relaunch) — RETIRED

_This generation is no longer written to. Kept because mVote is a port of it and
its audit findings are mVote's inheritance. App `3679681107`, voting asset $U._
_Last updated: 2026-08-19_

## Audit result (2026-08-19, fresh internal agent)

No Critical/High findings. All three invariants confirmed to hold. Auditor
independently verified on-chain that $U (`3081853135`) has **no clawback and no
freeze address**, neutralizing the one theoretical asset-config attack. Five
Low/Info hardening items surfaced; four applied to the contract, one is a deploy
requirement:

- **Applied — explicit AppCall index:** `Assert(Txn.group_index() == Int(0))` in
  `cast_vote` (safety was already emergent from the type asserts; now explicit).
- **Applied — clawback guard:** `Assert(Gtxn[1].asset_sender() == zero)` on the
  locked $U transfer (future-proofs if $U were ever reconfigured with clawback).
- **Applied — choice slot hygiene:** vote box stores `Itob(choice)` not raw arg.
- **Applied — founder address validation:** `Assert(Len(args[1]) == 32)` in
  `update_founder`.
- **Deploy requirement (L1):** the app min-balance is validated at the AppCall
  (index 0) where the vote box is created, but the voter's MBR payment settles at
  index 2 — so the app must hold a **standing buffer ≥ 26,900 µALGO** (one
  vote-box MBR) at all times. This buffer never depletes (each vote nets zero),
  but it is **required, not optional**. Verify on testnet: a zero-buffer app must
  reject the first vote; a buffered app must accept it.

## What UVote is

The resurrected MagnetDAO voting surface, rebranded **UVote**, under a broader,
honest framing: **advisory, founder-led governance**. The founder posts a
direction question — scope is open (liquidity, protocol parameters, treasury/
investment direction, anything) — and $U holders signal by locking whole $U at
the moment they vote. Nothing on-chain executes on the result; the tally is
advisory input the founder acts on under the existing MagnetFi trust model.

This does **not** change any MagnetFi contract or its "no external governance at
launch" security posture. UVote is a standalone signalling contract over $U.

### The model (unchanged from v1, confirmed against the deployed contract)
- **Founder-only** proposal creation, 7-day window.
- **Vote = lock at time of vote.** 100 $U locked = 100 voting power; a holder
  chooses how much to lock, up to their balance. Whole $U only.
- **One vote per wallet per proposal.**
- **Reclaim after close.** Locked $U returns in full once the window ends.

## Why a redeploy (not a patch of the live app)

The live app (`3554779766`) is immutable and carries 4 open audit findings
deferred "before significant token volume." Promoting Vote to a first-class nav
item is that trigger. On-chain check confirmed the live app has **1 historical
proposal, 0 outstanding votes, 0 $U locked** — nothing to migrate. Clean
redeploy, retire the old app, re-point the frontend.

## Contract — `contracts/uvote/uvote/uvote.py` (PyTeal v8)

Kept in PyTeal (not ported to PuyaPy) deliberately: the v1 logic is audited and
battle-tested end-to-end; surgical fixes on the known-good base preserve that
confidence and minimize change surface.

### Findings closed
| # | Sev | Finding (v1) | Fix in v2 |
|---|-----|--------------|-----------|
| 1 | Med — token theft | `cast_vote` never checked the $U transfer's sender | `Assert(Gtxn[1].sender() == Txn.sender())` — the locked $U is always funded by the credited/reclaiming wallet |
| 2 | Med — tally integrity | `choice <= 3` accepted even for empty slots | proposals store `num_choices`; `cast_vote` asserts `choice < num_choices`; `create_proposal` enforces choice contiguity (D requires C) |
| 3 | Low — griefing | founder could stack overlapping windows | one active proposal at a time via `last_end` global guard |
| 4 | Low — ops availability | app ALGO could deplete below vote-box MBR mid-window | voter pre-funds their own vote-box MBR (exact `26,900 µALGO` payment in the group), refunded on claim — the app balance can never gate new votes |

**Deliberately excluded:** any founder token-rescue / sweep path. The contract
holds exactly the sum of locked $U, and the only exit for $U is a voter
reclaiming their own recorded amount after close. This is what makes
"funds cannot be lost / always reclaimable" a hard guarantee, not a policy.

### Also hardened beyond the documented findings
- `cast_vote` asserts `Gtxn[1].asset_close_to() == zero` and
  `Gtxn[2].close_remainder_to() == zero` (no close-out drain via the group).
- MBR payment sender must equal the voter.

### Widened schema
- Question `128 → 256` bytes; each choice `32 → 96` bytes.
- Proposal box `304 → 696` bytes. MBR ≈ **0.286 ALGO/proposal, founder-paid.**

### Box layout (696 B, fixed offsets)
```
[0:8] start  [8:16] end  [16:24] votes_a  [24:32] votes_b
[32:40] votes_c  [40:48] votes_d  [48:56] num_choices
[56:312] question(256)  [312:408] A(96)  [408:504] B(96)
[504:600] C(96)  [600:696] D(96)
```
Vote box (16 B): `[0:8] choice  [8:16] locked_amount`. Key `vote_{id8}{pubkey32}`.

### Global state
`founder`, `pending_founder` (bytes) · `magnet_asa_id`, `proposal_count`,
`last_end` (uints) → **StateSchema(num_uints=3, num_byte_slices=2)**.

### Transaction shapes
- **create_proposal** (founder): AppCall, args `[question, a, b, c, d]`.
- **cast_vote** (voter): group of 3 — `[0]` AppCall `[cast_vote, id8, choice8]`,
  `[1]` AXFER whole $U → app, `[2]` Payment `26,900 µALGO` → app.
- **claim_tokens** (voter, after close): AppCall `[claim_tokens, id8]`;
  outer `flat_fee=true, fee=3000` (covers 2 inner txns: $U return + MBR refund).

## Final re-audit (2026-08-20, live App 3679681107, creative/out-of-bounds mandate)

Second independent adversarial pass AFTER deploy, verifying (a) nothing critical
was missed and (b) the four post-audit hardening edits didn't regress anything.
Deployed approval program confirmed **byte-for-byte identical** to `uvote.py`.
**No Critical/High/Medium. All three invariants hold. All four hardening edits
regression-free.** Two structural guarantees confirmed:

- **App is immutable + non-deletable.** UpdateApplication/DeleteApplication fall
  through to `Reject()` — the founder can never add a sweep path or brick logic.
- **$U freeze + clawback are permanently disabled at the protocol level** (both
  were zero at asset creation → unsettable forever, even by the surviving
  manager). The entire asset-reconfiguration attack class is neutralized
  structurally, not just by the L4 guard.

Two zero-urgency defense-in-depth notes — **cannot be applied to the live
immutable app; for any FUTURE redeploy only** (do NOT edit `uvote.py` now, it must
stay byte-identical to the live deploy):
- I-1: add `Assert(Global.group_size() == Int(1))` to `claim_tokens` (belt-and-
  suspenders; claim is already safe in any group — box delete precedes inner txns,
  key is caller-scoped, no double-claim/fee-pool advantage exists).
- I-2: use the checked `Assert(BoxCreate(...) == Int(1))` form in `create_proposal`
  (currently safe only via monotonic `proposal_count`; make it self-evident).

## Invariants the audit must confirm
1. **Voting can't be manipulated** — no double-vote, no crediting weight you
   didn't lock, no voting into non-existent choices, no tally overflow, no
   voting outside the window.
2. **Funds can't be lost in the lock** — no code path removes $U except a
   voter's own `claim_tokens`; no founder sweep; contract always holds ≥ sum of
   recorded locked amounts.
3. **Always reclaimable after expiry** — every recorded vote can be claimed
   after `end_time`, independent of app ALGO balance or founder cooperation.

## Frontend — BUILT (2026-08-19)
- Route `/vote` live; nav label **"Vote"** (between Pools/Contact); page header **UVote**.
- Admin gated to `MAGNETFI_ADMIN_ADDRESS` (same wallet becomes contract `founder`).
- **Wallet-signed deploy handshake** in the admin panel (no seed script): step 1
  create app (`uints=3/bytes=2`, `appArgs=[magnet_asa]`), step 2 fund + `optin_asa`.
  Prints the App ID to paste into `UVOTE_APP_IDS` in `web/src/lib/uvote.ts`.
- Files: `lib/uvote.ts` (config + box decoders), `lib/uvoteReads.ts`,
  `lib/uvoteClient.ts` (castVote 3-txn group + claimTokens), `lib/uvoteAdmin.ts`
  (deploy + createProposal + updateFounder, embedded bytecode), `app/vote/*`,
  `components/vote/*` (ProposalCard, VoteModal, CreateProposalModal, AdminPanel).
- `tsc --noEmit` clean; production build compiles `/vote`.
- ~~Still TODO: retire old `/dao` route + `dao.ts` cruft; set `UVOTE_APP_ID`;
  founder canary.~~ **All done.** Verified 2026-10-27: `/dao` and `/vote` both
  308-redirect to `/tokens#governance` (`web/next.config.js`), no `dao.ts`
  exists, and `UVOTE_APP_ID` resolves to `3679681107` in
  `web/src/lib/uvote.ts`.

### Go-live sequence
1. Admin connects (MagnetFi admin wallet) on `/vote` → **Deploy UVote** (2 signatures).
2. Paste printed App ID into `UVOTE_APP_IDS.mainnet` in `web/src/lib/uvote.ts`; redeploy site.
3. Founder canary: create a proposal, self-vote a few $U, reclaim after close.
4. Retire `/dao`.

## Deploy sequence (after audit sign-off)
1. `deploy_uvote.py` (adapt `deploy_voting.py`): create (schema uints=3) → fund →
   `optin_asa`. Voters self-fund per-vote MBR, but the app still needs base 0.1 +
   ASA opt-in 0.1 + a **standing ≥ 26,900 µALGO buffer** (audit L1) — fund
   ~0.3 ALGO. Buffer never depletes; it absorbs the index-0/index-2 settlement gap.
2. 2-step founder transfer to the real founder wallet (`update_founder` →
   `accept_founder`).
3. Point frontend `UVOTE_APP_ID` at the new app; ship `/vote`.
4. Retire old app `3554779766` from the UI.
