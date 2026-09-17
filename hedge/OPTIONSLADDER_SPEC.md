# Option Ladder — Technical Spec

Implementation specification. Rationale lives in [OPTIONSLADDER.md](./OPTIONSLADDER.md); this covers state, transitions, math, and invariants.

**Revision 6.** Fixes the `total_obligations` accounting defect, pins checkpoints to minute boundaries, adds a reference-price plausibility gate, and specifies attestation field provenance. Settlement derivation moves from the candle open to OHLC4 — an off-chain keeper change with no contract impact.

---

## Threat Model

The operator is assumed honest. The deterrent against a dishonest one is **public verifiability**: every settlement is derived from published 1-minute candles on four major exchanges, permanently checkable by anyone, with all four quotes written on-chain.

What this spec defends against:

- **External participants** attacking the contract or griefing other users
- **Honest-operation failure** — a keeper that dies, a venue that lags, an admin that fat-fingers a parameter

The second matters more than it looks. The contract is non-upgradeable, so an operator mistake is permanent.

**Explicitly not defended against:** a small stake on an unlikely band taking the whole pot. That is the leverage the product exists to sell, and it is uncapped by decision.

---

## Operating Model

Unattended keeper, no human approval step anywhere.

```
09:01:05   read 4 venues' 09:00 candle → OHLC4 → sign → PUBLISH → submit lock()
09:01:10   create tomorrow's round
16:01:05   read 4 venues' 16:00 candle → OHLC4 → sign → PUBLISH → submit resolve()
16:01:15   settle_batch winners, close_batch losers
```

Queries run just after the checkpoint minute closes, since OHLC4 needs the completed candle. `create_round` accepts the keeper as well as the admin, so the conveyor needs no human step.

**Only the operator can sign. Anyone can submit.** `lock` and `resolve` verify a signature, not a sender, so a published attestation can be relayed by any party. A reliability backup, not a dependency.

---

## Constants

| Constant | Value | Notes |
|---|---|---|
| `BAND_COUNT` | 9 | |
| `BAND_BOUNDS_BPS` | `9650, 9775, 9875, 9950, 10050, 10125, 10225, 10350` | ±0.5 / 1.25 / 2.25 / 3.5% of reference. Admin-tunable, snapshotted per round |
| `BPS_DENOM` | 10_000 | |
| `RAKE_BPS_CAP` | 1_000 | 10% ceiling, not raisable. Default 400 |
| `MIN_STAKE` | 5_000_000 | 5 mUSD. Admin-settable within `[MIN_STAKE_FLOOR, MIN_STAKE_CAP]`, snapshotted per round |
| `MIN_STAKE_FLOOR` / `MIN_STAKE_CAP` | 1_000_000 / 1_000_000_000 | 1 – 1,000 mUSD. The floor keeps `get_ladder`'s `muldiv` away from overflow at dust `band_stake` |
| `MAX_POSITION_STAKE` | 1_000_000_000_000 | 1M mUSD per position box. An overflow bound, **not** a concentration limit |
| `MIN_OCCUPIED_BANDS` | 2 | Liveness check only — see [Viability](#viability) |
| `MIN_ENTRY_WINDOW` / `MAX_ENTRY_WINDOW` | 3600 / 172_800 | |
| `MIN_SESSION` / `MAX_SESSION` | 7_200 / 86_400 | `MIN_SESSION > LOCK_DEADLINE` |
| `MAX_SCHEDULE_AHEAD` | 172_800 | 2 days |
| `LOCK_DEADLINE` | 120 s | |
| `BOUNTY_DELAY` | 300 s | After resolve/void before `CLOSE_BOUNTY` is payable |
| `RESOLVE_DEADLINE` | 259_200 s | 72h |
| `CLEANUP_GRACE` | 7 days | |
| `FORFEIT_PERIOD` | 180 days | |
| `SOURCE_COUNT` / `MIN_SOURCES` | 4 / 3 | Coinbase, Kraken, Gemini, Bitstamp |
| `PRICE_SANITY_LO` / `HI` | 2_000 / 50_000 | Settlement 20%–500% of reference |
| `REF_DRIFT_LO` / `HI` | 5_000 / 20_000 | Reference 50%–200% of the previous round's settlement |
| `LOCK_SPREAD_CAP_BPS` | 200 | 2% max venue spread **at lock only** — an operator-error detector |
| `MIN_REFERENCE_PRICE` / `MAX` | 1_000_000 / 100_000_000_000_000 | $1 – $100M. Overflow bounds, not plausibility |
| `BOX_MBR` | 41_700 µALGO | Position box. Admin-settable within a cap; the amount collected is stored in the box and refunded exactly |
| `PAYOUT_FEE` | 8_000 µALGO | Charged once per box. Admin-settable within a cap; stored in the box |
| `ROUND_BOX_MBR` | 128_900 µALGO | Reserved in the `withdraw_operating_algo` floor so `create_round` cannot be starved |
| `CLOSE_BOUNTY` | 3_000 µALGO | Paid to a third party who calls a terminal method for someone else, after `BOUNTY_DELAY` |

```
band_boundary_price[i] = muldiv(reference_price, band_bounds[i], BPS_DENOM)
band i covers  (boundary[i−1], boundary[i]]    boundary[−1] = 0, boundary[8] = ∞
```

Unsigned bps multipliers throughout — no sign flags anywhere.

---

## State Machine

```
      create_round
           │
           ▼
        OPEN ──────── enter()
           │
           ├─ lock()              ≥2 bands ──▶ LOCKED
           │                      <2 bands ──▶ VOID (thin)
           │
           ├─ void_round()        after lock_time + LOCK_DEADLINE ──▶ VOID (no_lock)
           │
           ├─ cancel_empty_round()  admin, only while position_count == 0 ──▶ box deleted
           │
           └─ admin_void_round()    admin ──▶ VOID (admin_void), full refunds, no rake

        LOCKED
           │
           ├─ resolve()           winning band has stake ──▶ RESOLVED
           │                      winning band empty     ──▶ VOID (empty_band)
           │
           └─ void_round()        after resolve_time + RESOLVE_DEADLINE ──▶ VOID (no_resolve)

      RESOLVED ── settle_position()  winners: payout + MBR, box deleted
                ─ close_position()   losers:  MBR,          box deleted
      VOID     ── refund_position()  all:     stake + MBR,  box deleted
                                      │
                                      ▼
                              cleanup_round() ──▶ round box deleted (no stored status)
                                      │
                                      ▼
                              purge_position()  any box orphaned by the forfeit branch
```

**Five VOID reasons:** `thin`, `empty_band`, `no_lock`, `no_resolve` are mechanical; `admin_void` is the operator's recovery lever and is **OPEN-only, full-refund, no-rake**.

> `cancel_empty_round` alone was not a recovery lever — a bot entering `min_stake` seconds after `RoundCreated` disarms it permanently for about $0.002, after which a fat-fingered schedule could block the conveyor for days with no exit but `void_round` at `lock_time + LOCK_DEADLINE`. `admin_void_round` restores it without weakening Invariant 5's substance: before lock no reference price exists, so voiding is informationally neutral, and every participant receives 100% back.

> **The void is a single deadline, derived from time alone.** Revision 4 had a two-step `initiate_void`/`finalize_void` with a stored timer, intended so a late `resolve` could still win during the delay. It could not: `resolve` was time-barred at 48h and `initiate_void` opened after 48h — disjoint windows, so the delay protected nobody and added 24h to every keeper-failure void. Worse, the stored timer had no one-shot guard, so anyone could re-arm it every 23 hours for ~0.37 ALGO/year and freeze a round's escrow permanently — and a naive keeper retry loop would do it accidentally to itself. Removing the state removed the bug. `RESOLVE_DEADLINE` is now 72h, so a winner has three days to relay a published attestation.

### Viability

`MIN_OCCUPIED_BANDS = 2` voids a round where every stake sits in one band, because that configuration pays `1 − rake` to everyone and is not a market.

**It is a liveness check and nothing more.** Occupancy only ever increases, so anyone can satisfy it with a minimum stake on a second band. If they do, they are buying cheap exposure to an outcome the crowd is dismissing — which is the product, not an attack on it. The test does not protect participants from their own concentration and is not intended to.

---

## Transition Table

Authoritative for every state-mutating method. Read-only methods (`get_round`, `get_position`, `get_ladder`) are listed under [Bot API](#bot-api).

| Method | Sender | Status | Guards | Mutates | Result |
|---|---|---|---|---|---|
| `create_application` | — | — | — | `admin ← Txn.sender` | — |
| `bootstrap` | `admin` | — | `musd_asset_id == 0` (**one-shot**); `asset_id == MUSD_ASSET_ID`; decimals == 6; unit name == "mUSD"; **`clawback == zero`**; **`freeze == zero`**; `total > 0`; `rake <= RAKE_BPS_CAP` | `musd_asset_id`, `price_feed_id`, `treasury`, `oracle_pubkey`, `keeper`, `default_rake_bps`, `min_stake`; inner opt-in to mUSD | — |
| `propose_admin` | `admin` | — | — | `pending_admin` (zero = cancel) | — |
| `accept_admin` | `pending_admin` | — | `pending != zero` | `admin`; clears `pending_admin` | — |
| `set_keeper` / `set_treasury` | `admin` | — | `!= zero_address` | the named global | — |
| `set_oracle_pubkey` | `admin` | — | 32 bytes; `!= bzero(32)` | `oracle_pubkey` | — |
| `set_box_mbr` / `set_payout_fee` | `admin` | — | within hard caps | the named global (future boxes only) | — |
| `set_default_rake_bps` | `admin` | — | `<= RAKE_BPS_CAP` | `default_rake_bps` | — |
| `set_min_stake` | `admin` | — | `MIN_STAKE_FLOOR <= v <= MIN_STAKE_CAP` | `min_stake` | — |
| `set_band_bounds` | `admin` | — | strictly increasing; straddles `BPS_DENOM`; each entry in `[5_000, 20_000]`; no single band wider than 1_000 bps | `band_bounds` | — |
| `set_paused` | `admin` | — | — | `paused` | — |
| `sweep_rake` | **anyone** | — | `rake_owed > 0`; treasury opted in; `total_obligations + rake_owed <= musd_balance` | `rake_owed → treasury`; `rake_owed ← 0` | — |
| `sweep_excess_musd` | `admin` | — | `total_obligations + rake_owed <= musd_balance`; `amt <= musd_balance − total_obligations − rake_owed` | mUSD → treasury | — |
| `withdraw_operating_algo` | `admin` | — | `balance − amt >= min_balance + fee_reserve + ROUND_BOX_MBR + CLOSE_BOUNTY` | ALGO → admin | — |
| `create_round` | `admin` or `keeper` | — | `!paused`; `open_round_id == 0`; **`round_id = ++round_count`**; **`assert not box_exists(r‖round_id)`**; `now <= open_time <= now + MAX_SCHEDULE_AHEAD`; **`lock_time % 60 == 0`**; **`resolve_time % 60 == 0`**; entry-window and session bounds | round box; snapshots `rake_bps`, `oracle_pubkey`, `band_bounds`, `price_feed_id`, `min_stake`, `box_mbr`, `payout_fee`; `open_round_id ← id` | **OPEN** |
| `cancel_empty_round` | `admin` | OPEN | `position_count == 0`; `total_stake == 0` | deletes round box; `open_round_id ← 0` | — |
| `admin_void_round` | `admin` | OPEN | — | `status ← VOID`; `void_reason ← admin_void`; `remaining_payable ← total_stake`; `open_round_id ← 0` | **VOID** |
| `enter` | not `admin`/`keeper`/`treasury` | OPEN | `!paused` (**global, read live**); `round_id == open_round_id`; `open_time <= now < lock_time`; 3-txn group asserts; `min_stake <= stake`; `stake <= MAX_POSITION_STAKE − box.stake`; `band < 9` | `band_stake[b] +=`; `total_stake +=`; `total_obligations +=`; box create-or-add; on create: `position_count +=`, `fee_reserve += PAYOUT_FEE` | OPEN |
| `lock` | **anyone** | OPEN | `now >= lock_time`; `now <= lock_time + LOCK_DEADLINE`; attestation valid, `checkpoint_kind == LOCK`; `MIN_REFERENCE_PRICE <= ref <= MAX_REFERENCE_PRICE`; **reference within `REF_DRIFT` of `last_settlement_price` when non-zero**; **venue spread `<= LOCK_SPREAD_CAP_BPS`**; boundaries strictly increasing | `reference_price`; `ref_sources[4]`; `open_round_id ← 0`; **≥2 bands:** `status ← LOCKED` · **<2:** `status ← VOID`, `void_reason ← thin`, `remaining_payable ← total_stake` | **LOCKED** or **VOID** |
| `resolve` | **anyone** | LOCKED | `now >= resolve_time`; `now <= resolve_time + RESOLVE_DEADLINE`; attestation valid, `checkpoint_kind == RESOLVE`; price sanity vs reference | `settlement_price`; `settle_sources[4]`; `winning_band`; see branches | **RESOLVED** or **VOID** |
| `void_round` | anyone | OPEN or LOCKED | OPEN: `now > lock_time + LOCK_DEADLINE`<br>LOCKED: `now > resolve_time + RESOLVE_DEADLINE` | `status ← VOID`; `void_reason ← no_lock`/`no_resolve`; `remaining_payable ← total_stake`; `if open_round_id == round_id: open_round_id ← 0` | **VOID** |
| `settle_position` | anyone | RESOLVED | box exists; `band == winning_band`; `expected_payee` matches; payee opted into mUSD | payout + `box.mbr_paid` → payee; bounty → caller if caller ≠ owner and past `BOUNTY_DELAY`; `remaining_payable −= payout`; **`total_obligations −= payout`**; `position_count −=`; `fee_reserve −=`; **deletes box** | RESOLVED |
| `close_position` | anyone | RESOLVED | box exists; `band != winning_band`; `expected_payee` matches; payee account exists (**existence, not mUSD opt-in** — this path moves only ALGO, and an opt-in test would lock out funded non-opted-in accounts); past `CLEANUP_GRACE` an unreceivable payee's deposit escheats so one redirect cannot pin the round to `FORFEIT_PERIOD` | `box.mbr_paid` → payee; bounty → caller if caller ≠ owner and past `BOUNTY_DELAY`; **`total_obligations` unchanged**; `position_count −=`; `fee_reserve −=`; **deletes box** | RESOLVED |
| `refund_position` | anyone | VOID | box exists; `stake <= remaining_payable`; `expected_payee` matches; payee opted into mUSD | stake + `box.mbr_paid` → payee; bounty → caller if caller ≠ owner and past `BOUNTY_DELAY`; `remaining_payable −= stake`; **`total_obligations −= stake`**; `position_count −=`; `fee_reserve −=`; **deletes box** | VOID |
| `set_payout_recipient` | position owner | OPEN/LOCKED/RESOLVED/VOID | box exists | `box.recipient` | unchanged |
| `purge_position` | anyone | — | round box absent; position box exists | `box.mbr_paid` → **`Txn.sender`**; `fee_reserve −=`; deletes box | — |
| `*_batch` | anyone | as above | **skips** invalid entries; an all-skipped batch is a successful no-op | as above per entry | unchanged |
| `cleanup_round` | anyone | RESOLVED or VOID | `now > resolve_time + CLEANUP_GRACE`; `position_count == 0` **or** `now > resolve_time + FORFEIT_PERIOD` | `remaining_payable → rake_owed`; `total_obligations −= remaining_payable`; **deletes round box, then** pays bounty → caller | round box deleted; no stored status |

**`payee` = `box.recipient` if set, else `owner`** — applied identically by all three value-returning terminal methods. Revision 4 had `close_position` pay `owner` while the others paid `recipient`, which stranded a box permanently when an owner closed their account.

**`purge_position` pays the caller, not the owner.** It is only reachable after the round box is gone — at minimum `CLEANUP_GRACE`, and in the orphan case `FORFEIT_PERIOD` — by which point the position is demonstrably abandoned. Paying the caller guarantees every box is unconditionally deletable, which is what Invariant 9 claims.

### `resolve` branches

```
winning_band has stake:
    payable_pot        = muldiv(total_stake, BPS_DENOM − rake_bps, BPS_DENOM)
    remaining_payable  = payable_pot
    rake_owed         += total_stake − payable_pot     ← accrued, never transferred here
    total_obligations -= total_stake − payable_pot
    → RESOLVED

winning_band empty:
    payable_pot        = 0
    remaining_payable  = total_stake                   ← full refunds
    no rake accrued
    → VOID(empty_band)
```

### The `total_obligations` identity

```
enter              += stake
resolve RESOLVED   −= total_stake − payable_pot        (the rake leaves the obligation)
resolve VOID       unchanged                            (the full stake is still owed)
settle_position    −= payout
close_position      unchanged                           ← a loser's stake was reallocated, not extinguished
refund_position    −= stake
cleanup_round      −= remaining_payable                 (dust/forfeits move to rake_owed)
```

> **`close_position` must not touch `total_obligations`.** Revision 5 decremented it by `stake`, which double-counts: at `resolve` the losing stakes were folded into `payable_pot` and are still owed — to the winners. The decrements then over-ran the counter by the entire losing pot. Loudly, that underflows and panics, which bricks `settle`, `close` and `cleanup` alike and strands the round permanently. Quietly — once several rounds overlap and the excess is absorbed — `total_obligations` simply under-reports, and `sweep_excess_musd` then authorises an honest admin to sweep other rounds' live escrow to treasury.
>
> Every `total_obligations` decrement uses checked subtraction with a named error, and both sweep methods assert `total_obligations + rake_owed <= musd_balance` first, so any future drift fails closed rather than authorising a transfer.

> **Rake accrues to a counter; it is never transferred inside `resolve`.** A direct transfer would revert the whole call if the treasury were not opted into mUSD — one configuration mistake voiding every round in flight. `sweep_rake` is permissionless and separate, so settlement can never depend on treasury state. This is also why there is no per-round treasury snapshot: `resolve` never reads it.

---

## Storage

### Global

| Key | Type | Notes |
|---|---|---|
| `round_count`, `open_round_id` | uint64 | `round_count` is the sole source of round ids |
| `admin`, `pending_admin`, `keeper`, `treasury` | account | |
| `oracle_pubkey` | byte[32] | Snapshotted per round |
| `musd_asset_id`, `price_feed_id` | uint64 | Immutable after bootstrap |
| `default_rake_bps`, `min_stake`, `band_bounds[8]`, `box_mbr`, `payout_fee` | uint64 | Snapshotted per round |
| `last_settlement_price` | uint64 | Previous round's settlement. Bounds the next reference. 0 until the first resolve |
| `rake_owed` | uint64 | Accrued rake + forfeits, awaiting `sweep_rake` |
| `total_obligations` | uint64 | mUSD owed to users across all rounds. Makes Invariant 1 checkable on-chain and bounds `sweep_excess_musd` |
| `fee_reserve` | uint64 | µALGO committed to live positions. Floors `withdraw_operating_algo` |
| `paused` | uint64 | Blocks `create_round` and `enter`, **read live** |

> **`paused` is not snapshotted.** Revision 4 froze it per round to stop an admin pausing mid-window to lock a favourable ladder — an operator attack, now out of scope. The cost was that discovering a bug five minutes into an entry window meant accepting deposits for another 23h55m with no lever at all. Reading it live restores the emergency stop; funds already in are never trapped, because every exit path ignores `paused`.

### Round Box — `r ‖ round_id`

`open_time`, `lock_time`, `resolve_time`, `reference_price`, `settlement_price`, `ref_sources[4]`, `settle_sources[4]`, `band_stake[9]`, `total_stake`, `rake_bps`, `min_stake`, `box_mbr`, `payout_fee`, `oracle_pubkey`, `band_bounds[8]`, `price_feed_id`, `payable_pot`, `remaining_payable`, `winning_band`, `status`, `void_reason`, `position_count`.

Everything defining a round's terms is snapshotted at creation, so no admin action can change the terms of a round already underway.

### Position Box — `p ‖ round_id(8) ‖ owner(32) ‖ band(1)`

42-byte key. Value: `stake` (8) + `recipient` (32, zero = owner) + `mbr_paid` (8) + `fee_paid` (8) = 56 bytes.
`BOX_MBR = 2500 + 400 × (42 + 56) = 41,700`.

`mbr_paid` and `fee_paid` record what this box actually collected, so a later change to `box_mbr` or `payout_fee` cannot under- or over-refund an existing position. Both are consensus-parameter-derived and Algorand's have changed before; a non-upgradeable contract that hardcoded them would break `enter` for everyone if per-box MBR rose.

> **One box, recipient inline.** Revision 4 split `recipient` into a second optional box to cut MBR to 22,500 — chasing 12,800 µALGO, about a quarter of a cent — and specified neither its funding nor its deletion. The result was a 4:1-leverage ALGO drain ending in a protocol-wide payout freeze. Inline is 12,800 µALGO more expensive and has no attack surface.

**No `settled` flag.** Terminal operations delete the box, so existence *is* the flag and double-settle is structurally impossible.

**No tombstone.** A position box can only exist if `enter` succeeded against an OPEN round, so round-box-absent unambiguously means cleanup has run. `purge_position` needs no record of what the round was.

---

## Entry — three-transaction group

```
txn 0   pay   ALGO  →  app    round.box_mbr + round.payout_fee (new box)  or  0 (top-up)
txn 1   axfer mUSD  →  app    stake
txn 2   appl  enter(round_id, band_index)
```

`stake` is read from `payment.asset_amount`. **It is never a parameter** — if it were, `assert payment.asset_amount == stake` would be the only thing between the contract and free money.

Both value legs are typed ARC-4 transaction parameters (`gtxn.PaymentTransaction`, `gtxn.AssetTransferTransaction`) and fully asserted:

```
payment.group_index    == Txn.group_index − 1      mbr.group_index == Txn.group_index − 2
payment.xfer_asset     == musd_asset_id            mbr.receiver    == app address
payment.asset_receiver == app address              mbr.sender      == Txn.sender
payment.sender         == Txn.sender               mbr.close_to    == zero
payment.asset_close_to == zero                     mbr.rekey_to    == zero
payment.rekey_to       == zero                     mbr.amount      == exact (0 on top-up)
```

> An ARC-4 transaction parameter is a **group-index reference, not an exclusive claim.** Without pinning the index, one payment can be cited by nine `enter` calls in the same group — nine boxes on one deposit, or 9,000 mUSD of stake from a 1,000 mUSD transfer. The pinning plus the type declarations make double-citation structurally impossible.

The fee is charged once per box; a top-up pays zero, since the position still makes exactly one terminal transaction. **Whether this is a new box or a top-up is derived from box existence at execution time, never from a caller-supplied flag** — otherwise a caller declares "top-up" against a non-existent box and gets one free. Sequential execution makes the derivation safe even within one group: `[new, top-up]` works, `[top-up, new]` reverts on the first.

`enter` rejects `admin`, `keeper` and `treasury` — hygiene against the lazy case, trivially Sybil-defeated, and not claimed as a defence.

---

## Oracle

Four venues: Coinbase Exchange, Kraken, Gemini, Bitstamp. Real BTC-USD order books, no USDT pairs, no aggregators.

### The settled number

**OHLC4 of the 1-minute candle at the checkpoint — `(open + high + low + close) / 4` — median across four venues.**

Every value is published, permanent, and visible on any charting tool, so a participant can verify a settlement indefinitely. That is the deterrent this product runs on.

> **Not the candle open.** The open is the *first executed trade* of the minute, so moving it requires owning one print rather than holding a level — sweep two thin venues 0.2% at the tick and unwind seconds later. Worse, the manipulation is invisible on-chain: the four quotes written there are the true opens, so public verifiability verifies nothing. OHLC4 requires moving the open *and* the high *and* the low *and* the close — sustained pressure across the whole minute against arbitrage. And it is exactly as checkable, because every chart shows all four values. The open bought no verifiability the alternatives lack; it only cost manipulation resistance.

**Derivation is off-chain keeper policy.** The contract verifies a signature over a value and has no opinion on provenance, so the method can be tightened later without touching a non-upgradeable contract.

### Signed message

```
message = sha256( app_id ‖ round_id ‖ checkpoint_kind ‖ present_mask
                  ‖ price_feed_id ‖ prices[4] ‖ timestamps[4] )
verify  = ed25519verify_bare(message, sig, round.oracle_pubkey)
```

One aggregate attestation, not four signatures. With per-source signatures and an unsigned mask, the signatures become public the moment they reach the mempool and anyone can resubmit them with a different mask, selecting from a menu of medians after seeing every value. Signing the vector and mask together leaves exactly one valid submission **per signature**.

> **That last part is a keeper obligation, not a contract guarantee.** The contract accepts any signature valid for the checkpoint, so if the keeper signs twice for one `(round_id, kind)` — a retry after a failed submission, with a venue that has since dropped out — both attestations verify, both are public, and `resolve` is permissionless, so a participant picks whichever median falls in their band. It only decides a round when the settlement sits within roughly the inter-venue spread of a boundary, but the party choosing is the one who profits.
>
> **The keeper must sign once per `(round_id, checkpoint)`, persist that signature, and resubmit the identical bytes on every retry — never re-sign.**

**Field provenance is part of the specification, not an implementation detail.** When the contract reconstructs the message:

| Field | Source |
|---|---|
| `app_id` | `Global.current_application_id` — **never an argument** |
| `round_id` | the round box key |
| `checkpoint_kind` | the calling method's own literal |
| `price_feed_id` | `round.price_feed_id` (the snapshot) — **never an argument** |
| `present_mask`, `prices[4]`, `timestamps[4]`, `sig` | arguments |

> Taking `app_id` or `price_feed_id` from call arguments makes those bindings decorative — an attestation signed under the same key for another app or another feed would replay here. The natural mistake is to reconstruct the whole preimage from the ABI arguments, because that is the shape of signature-verification code.

`source_index ≡ array position`; distinctness is structural.

### Timestamps

**`timestamps[i]` is the candle's clock-aligned open boundary as reported by venue *i*** — the bucket key, in **seconds** since epoch, normalised by the keeper. Gemini's OHLC endpoint returns milliseconds; a keeper passing that raw value fails every round.

```
checkpoint = (kind == LOCK) ? lock_time : resolve_time      // asserted minute-aligned at create_round

for each source i in present_mask:
    assert timestamps[i] == checkpoint

assert Global.latest_timestamp >= checkpoint
assert Global.latest_timestamp <= checkpoint + deadline
```

> **Equality, not a tolerance.** Revision 5 redefined this field from a trade time to a bucket key but kept the old ±15s band. A bucket key is a deterministic function of the checkpoint, so a tolerance is the wrong shape: with `checkpoint mod 60` in [16,44] *no* boundary falls inside the window and the round becomes unresolvable by any attestation the keeper can sign; in [45,59] only the *next* minute validates and the round settles on the wrong candle. Only 27% of arbitrary checkpoints behaved as documented and 48% were fatal — and compressed localnet test timestamps are never minute-aligned, so the failures would have surfaced as flakiness. Asserting minute alignment at `create_round` and equality here removes the class, and deletes `CHECKPOINT_TOL` along with the inter-source bound that was only ever a proxy for it.

**The price must be from the checkpoint; the submission may be late.** Validating staleness against *now* would let a keeper submit a genuine 16:47 price as the 4pm settlement.

### Aggregation

```
assert present_mask > 0 and present_mask <= 0x0F
n = popcount(present_mask)
assert n >= MIN_SOURCES
assert every present price > 0

sort the 4 slots ascending, absent slots forced to MAX_UINT64 (fixed 5-comparator network)
n == 4 → a = sorted[1], b = sorted[2]; median = a + (b − a) / 2
n == 3 → median = sorted[1]
```

The sorting network is explicit and fixed, so the middle is well-defined for any present subset, and `a + (b − a)/2` cannot underflow. The mask bound rejects a keeper encoding bug — a 1-indexed or misordered mask — that would otherwise silently void the round.

**Spread never gates settlement.** Published for monitoring only. Gating on it would make a VOID purchasable by pushing one venue past a threshold, and would fire hardest during genuine dislocations — the days the tail bands win.

**Absent slots are written as `0`,** never the submitted value, so a three-source settlement is distinguishable on-chain from a four-source one.

### Price plausibility

```
lock:
    assert MIN_REFERENCE_PRICE <= reference_price <= MAX_REFERENCE_PRICE
    if last_settlement_price != 0:
        assert reference_price >= muldiv(last_settlement_price, REF_DRIFT_LO, BPS_DENOM)   // 50%
        assert reference_price <= muldiv(last_settlement_price, REF_DRIFT_HI, BPS_DENOM)   // 200%
    assert (max(present) − min(present)) <= muldiv(median, LOCK_SPREAD_CAP_BPS, BPS_DENOM) // 2%

resolve:
    assert settlement_price >= muldiv(reference_price, PRICE_SANITY_LO, BPS_DENOM)         // 20%
    assert settlement_price <= muldiv(reference_price, PRICE_SANITY_HI, BPS_DENOM)         // 500%
    last_settlement_price ← settlement_price
```

> **What the drift gate does and does not catch.** 50%–200% catches a decimal-scale error or an outright wrong asset. It does **not** catch a wrong *quote currency* — BTC-EUR for BTC-USD is roughly 0.92×, comfortably inside the band, while shifting every boundary by 8%: more than twice the widest band. Tightening enough to catch that (better than ~3%) would void legitimate rounds on a volatile day, which is the worse trade. What guards it instead is keeper configuration and the fact that a wrong-pair settlement is visible on-chain against four published candles.

> **The reference needs a plausibility gate, and revision 5 had none.** `MIN`/`MAX_REFERENCE_PRICE` span $1 to $100M — an overflow bound wearing a sanity check's label. The whole ladder spans 7% of the reference, so *any* reference error above ~3.5% decides the round. A wrong quote currency (BTC-EUR for BTC-USD, ≈0.92×) shifts every boundary 8% — 2.3× the widest band — and a flat session settles in the tail. All four venues agree, the median is clean, and the 20–500% settlement check passes comfortably. Binding the reference to the previous round's settlement catches every global scale and pair error.

> **There is a spread gate at `lock` and deliberately none at `resolve`.** The argument against spread-gating — that it makes a VOID purchasable by a participant facing a total loss — is correct at `resolve` and does not hold at `lock`, where no outcome exists yet and buying a void means paying to refund your own stake. At 2% the gate sits ~130× above the observed inter-venue agreement of 0.015%; it is an operator-error detector, not a manipulation defence.

---

## Math

```
payable_pot = muldiv(total_stake, BPS_DENOM − rake_bps, BPS_DENOM)
payout      = muldiv(payable_pot, stake, band_stake[winning_band])
assert payout <= remaining_payable ; remaining_payable −= payout
```

Live ladder: `multiple_bps[i] = band_stake[i] == 0 ? 0 : muldiv(provisional_payable, BPS_DENOM, band_stake[i])`. **The zero guard is mandatory** — with 9 bands an empty band is normal, and `get_ladder` computing all nine would panic on most rounds.

**`muldiv` everywhere, including `payable_pot`** — revision 4 mandated it and then wrote that one line as a plain `× /`. Overflow-safe comparisons use subtraction: `stake <= MAX_POSITION_STAKE − box.stake`, never `a + b <= MAX`.

The app holds one commingled mUSD balance across all rounds. `remaining_payable` is the per-round ceiling that turns any accounting error into a local revert rather than cross-round theft; `total_obligations` is the global figure that makes Invariant 1 checkable and bounds `sweep_excess_musd`.

**No carry-forward.** Unclaimed payouts and dust flow to `rake_owed`. An earlier design added them to the next round's pot after rake, which made a proportional claim on every band a risk-free claim on that money.

### Fee accounting

`PAYOUT_FEE = 8,000` against a worst case of 3 inner transactions plus the bounty:

```
inner axfer (payout)        1,000 fee
inner pay   (MBR)           1,000 fee
inner pay   (bounty)        1,000 fee + 3,000 amount
                            ─────────
                            6,000        →  2,000 µALGO margin
```

Inner fees use `Global.min_txn_fee`, not a hardcoded constant. `fee_reserve` decrements by `PAYOUT_FEE` on each terminal close; unspent margin stays with the app as surplus, which is conservative — the reserve can over-state what is committed but never under-state it.

> Revision 4 set `PAYOUT_FEE = 4,000` against exactly 4,000 of spend. Zero margin means any fourth inner transaction, or any rise in the network fee floor, makes `fee_reserve` under-report — after which an honest `withdraw_operating_algo` can take ALGO that is actually committed, and payouts fail later for lack of balance.

---

## Batches

`settle_batch`, `close_batch`, `refund_batch` take an array of `(owner, band, expected_payee)` and **skip** entries failing their guards, returning a success bitmap. **An all-skipped batch succeeds as a no-op** — it does not assert that at least one entry worked.

> **`expected_payee` is load-bearing.** `settle` and `refund` must read the payee's mUSD holding, and in the AVM an asset-holding read against an account absent from the transaction's resource array is a *hard program failure* — not a catchable guard, so skip logic cannot reach it. Without the parameter, a griefer calls `set_payout_recipient` on one position they own moments before the keeper's batch, the resolved payee is no longer in the group's resource array, and **the entire batch reverts** for one transaction fee, every round. Passing the expected payee makes the holding read target an address the caller supplied, available by construction, and a mismatch becomes an ordinary skip.

> **No `≥1 succeeded` assert.** A batch whose entries were all already settled by bounty-collecting third parties would otherwise revert, and a keeper retry loop written the obvious way would resubmit it forever. Burning a fee on an empty batch is the caller's problem; a reverting keeper path is not.

**A full batch of 8 needs FOUR top-level app calls.** Three limits bind, and the tightest is not the one you would guess:

| Limit | Per top-level app call | A batch of 8 needs |
|---|---|---|
| Inner transactions | 16 | up to 24 (settle emits 3 each) |
| References | 8, of which ≤4 accounts | 1 round box + 8 position boxes + up to 8 payees + the asset |
| Opcode budget | 700 | ~900 |

Three app calls give 48 inner transactions, 24 reference slots and 12 account slots — enough on paper, and still not enough in practice, because references are pooled for *use* but each transaction may only *declare* 8 of them. Measured: a full batch places in four calls and fails in three. With a single app call it dies at the fifth entry on the inner-transaction limit.

**Pad with `noop`, not a readonly method.** Clients route readonly calls through simulate, so they never land in the submitted group — a keeper padding with `get_solvency` ships a one-call group and fails partway through. `noop` exists for this.

**`ensure_budget` scales with the batch, rather than being a constant.** A flat figure is wrong in both directions: too low and a full batch dies mid-loop on "dynamic cost budget exceeded" — 8 settles measured well over 2,000, not the ~1,400 a static reading of the source suggests — and too high makes every small batch pay for opup it does not need. `global OpcodeBudget` also reads what *remains* of the pooled budget, so a constant made the same transactions pass or fail on ordering alone.

---

## Non-upgradeable

```
UpdateApplication   rejected unconditionally, no admin exemption
DeleteApplication   rejected unconditionally
(ClearState cannot be rejected on Algorand — the clear program is `int 1` by
 protocol. Moot here: the contract has no local state to clear.)
OptIn / CloseOut                rejected (no local state)
```

The contract issues **no inner `acfg` ever**, and the only inner `appl` it can issue is an opcode-budget bump (`ensure_budget`), whose program is the constant `#pragma 6; int 1` — it cannot reference, call, or read any other application.

> Stated precisely because the earlier absolute claim was false. `ed25519verify_bare` costs 1900 opcodes against a 700-opcode budget per app call, so `lock` and `resolve` cannot execute in a bare single-transaction call; the budget is raised by opup, which is an inner app create-and-delete. Budget is drawn from **group credit, never the app account** — these methods are permissionless, and letting the app fund opup for any caller would bleed its ALGO balance until every payout failed.
>
> **Callers must over-pay fees.** A lone `lock` needs 4 opup inner transactions, so the group must carry ~5,000 µALGO of fee, not the 1,000 minimum. Nothing in the ABI signals this, and `lock`'s window is only `LOCK_DEADLINE` wide — a relayer that pays the minimum fee fails and may not have time to diagnose it. The keeper does this by default; a relay implementation must too. The app address is not mUSD's manager, reserve, freeze or clawback address.

**Asserted at bootstrap, not merely verified once:** mUSD (`3615600399`) must have freeze and clawback set to the zero address — permanent and irreversible on Algorand once set. MagnetFi cannot freeze or claw back Hedge's escrow, so isolation holds in both directions. Revision 5 rested this on a human's off-chain check protecting a non-upgradeable contract; decimals and a unit name are trivially forgeable by any third party's ASA, while clawback and freeze are the properties that actually matter.

Because bugs are permanent, `MAX_SCHEDULE_AHEAD`, `cancel_empty_round`, the bootstrap asset checks and the wide sanity bounds exist specifically to make operator foot-guns recoverable.

---

## Events (ARC-28)

`RoundCreated` · `RoundCancelled` · `Entered` · `Locked` (reference, sources[4], present_mask, n) · `Resolved` (settlement, sources[4], present_mask, n, winning_band, payable_pot) · `Voided` (reason) · `Settled` · `Closed` · `Refunded` · `Purged` · `RakeSwept`

---

## Bot API

```
GET  /ladder                   bands, stakes, live multiples, pot, time to lock,
                               session length, bands occupied, min stake
GET  /history                  reference, settlement, winning band, closing multiples, void reasons
GET  /position/{addr}
GET  /attestations/{round_id}  signed attestations, published at signing time
```

Backed by the readonly methods `get_round`, `get_position`, `get_ladder` plus the indexer. **No `POST /enter`** — the ABI is public and clients build their own groups; an operator-run entry endpoint would see every caller's intended band and size before signing. The frontend reads the ladder on-chain; the API is a convenience with no privileged role.

---

## Invariants

1. **Solvency.** `app mUSD balance >= total_obligations + rake_owed`, asserted at the top of both sweep methods so drift fails closed.
1a. **Obligation identity.** `total_obligations == Σ over live rounds of (remaining_payable if past lock, else total_stake)`. Tested across all three terminal paths on localnet.
2. **Rake only on RESOLVED.** No VOID path accrues rake.
3. **Round terms fixed at creation.** Rake, oracle key, band bounds, price feed, minimum stake.
4. **No claim dependency.** Every payout, refund, close and purge path is permissionless.
5. **No cancellation that costs a user anything.** The four mechanical VOID paths are state-driven; `cancel_empty_round` requires an empty round; `admin_void_round` is OPEN-only and refunds every participant in full with no rake, before any reference price exists.
6. **Conservation.** `total_stake ≡ payable_pot + rake_accrued` on RESOLVED; `remaining_payable ≡ total_stake` on every VOID.
7. **Entries are terminal.** Settled, closed, or refunded — never withdrawn.
8. **Exactly one open round.**
9. **No stranded funds.** Every reachable state has a permissionless exit within a bounded deadline; every position box has a terminal call that returns its MBR unconditionally; and any mUSD reaching the app outside an entry group is recoverable via `sweep_excess_musd`.
10. **Ring-fenced.** No mint, no burn, no shared oracle key, non-upgradeable. The only inner application call is a constant no-op opup for opcode budget; no path can reach a MagnetFi app.

## Residual Trust

The operator holds the only signing key and can decline to sign, which voids the round after the deadline and refunds everyone.

**What bounds it is public verifiability, not a mechanism.** Every settlement is the open of a published 1-minute candle on four major exchanges — permanently checkable against the four quotes written on-chain. A wrong price is not deniable. A `no_lock` or `no_resolve` void carries its own reason code, so keeper-failure voids are distinguishable and the rate is visible in `GET /history`.

The economic case is the rest: one round's position is worth a fraction of a functioning platform.

This cannot be fully removed on Algorand today — there is no credible third-party price oracle on this chain, which is why every protocol here runs its own feed. m-of-n signing across independent parties is the path that would close it, and is out of scope at this stage.

---

## Edge Cases

| Case | Handling |
|---|---|
| Fewer than 2 bands occupied at lock | VOID(thin), full refunds, no rake |
| Winning band empty | VOID(empty_band), full refunds, no rake |
| Sole entrant in winning band | Takes the whole payable pot. **Intended and uncapped** — this is the product |
| Covering all nine bands | Guaranteed loss of exactly the rake. Their choice, no defence needed |
| Keeper never signs | Void at the deadline, full refunds |
| Keeper signs but never submits | Anyone relays the published attestation, for 72 hours |
| Keeper retry loop calls a void method repeatedly | No stored timer to re-arm; deadlines are derived from `resolve_time` alone |
| Treasury not opted into mUSD | `resolve` unaffected — rake accrues to a counter. `sweep_rake` waits |
| Payee not opted into mUSD | `set_payout_recipient` redirects. Keeper's batch skips them meanwhile |
| Owner closes their Algorand account | Terminal call reverts; after `FORFEIT_PERIOD` the box is orphaned and `purge_position` pays the caller, so it is always deletable |
| mUSD sent directly to the app address | Recoverable via `sweep_excess_musd`, bounded by `total_obligations` and gated on the solvency assert |
| Every entry in a keeper batch already settled by bounty bots | Batch succeeds as a no-op with an empty bitmap; the retry loop terminates |
| Admin fat-fingers `open_time` | Bounded by `MAX_SCHEDULE_AHEAD`; `cancel_empty_round` clears it while empty, and `admin_void_round` recovers it once anyone has entered |
| Checkpoint not minute-aligned | Rejected at `create_round`. Otherwise no attestation could ever validate and the round would be unresolvable from birth |
| Keeper's venue config on the wrong pair | Reference fails the drift bound against the previous settlement, or the 2% lock spread gate |
| Griefer changes their payout recipient before a batch | Entry skips on the `expected_payee` mismatch; the rest of the batch settles |
| Admin bootstraps the wrong asset | Rejected — decimals and unit name are asserted |
| `create_round` retried with a stale id | Rejected — ids come from `round_count` and the box-existence assert is unconditional |
| Genuine 55% price move | Settles normally; sanity bounds are 20%–500% |
| Price exactly on a boundary | Inclusive upper bound. Deterministic |
| Duplicate terminal call | Box is gone; existence assert fails |
| Terminal call on a nonexistent box | Rejected. **Never creates** — an unguarded `BoxMap` write would mint boxes at a transaction fee each and push the app under minimum balance, freezing every payout in every round |
| Paused mid-window | Entries stop immediately. Every exit path ignores `paused`, so funds are never trapped |

---

## Build Order

1. Contract — Algorand Python, localnet then testnet
2. Keeper — 4-venue candle read, median, sign, publish, submit, batch payouts. Off-chain and private per the [open source carve-out](./OVERVIEW.md#open-source-policy)
3. Frontend — ladder histogram from on-chain reads, entry, positions, history
4. Bot API + MCP server

`create_round` takes explicit timestamps, so tests compress a full cycle into seconds on localnet.
