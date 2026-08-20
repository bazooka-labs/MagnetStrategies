# UVote — Build Spec (v2 voting relaunch)

_Status: spec + contract written; **internal audit PASSED** (no Critical/High; all
three invariants hold). Defense-in-depth hardening applied. Pending testnet
verification + frontend port before mainnet deploy._
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

## Contract — `contracts/magnetdao/uvote/uvote.py` (PyTeal v8)

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
- Still TODO: retire old `/dao` route + `dao.ts` cruft once `/vote` is confirmed live;
  set `UVOTE_APP_ID` after the deploy handshake; founder canary.

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
