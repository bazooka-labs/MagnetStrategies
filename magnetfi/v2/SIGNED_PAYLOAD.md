# MagnetFi v4 — Signed Price Payload Format

**Status: format defined and tested; the vault verifier and the publisher are not
built.** Rationale for the approach is in
[LP_ORACLE.md → v4](./LP_ORACLE.md#v4--signed-payloads-decided-2026-10-07-not-yet-built).
This document is the contract between the signer and the vault, and the two must
agree **byte for byte**.

Reference implementation: `magnetfi/v2/signer/payload.py` (59 tests). Nothing
imports it yet, so changing it today is free. That stops being true the moment a
verifier is deployed — and the vault is the one contract with **no repointing
path**, so a format mistake is a migration.

## Layout — 85 bytes, big-endian

| offset | size | field | why it is inside the signature |
|---|---|---|---|
| 0 | 4 | `magic` = `MFLP` | domain separation: this key must never sign something another verifier could read as a price, nor the reverse |
| 4 | 1 | `version` = 1 | lets the format change without ambiguity |
| 5 | 32 | `genesis` | binds to one network — app ids are per-network counters and can collide |
| 37 | 8 | `target_app` | binds to **one** vault app id, so a payload cannot be replayed against another deployment |
| 45 | 8 | `lp_asa_id` | the **LP token ASA** this price is per unit of |
| 53 | 8 | `price_min` | low end of the band, mUSD scaled `1e6` |
| 61 | 8 | `price_max` | high end; equal to `price_min` today |
| 69 | 8 | `issued_at` | unix seconds at signing |
| 77 | 8 | `max_age` | signer's **requested** validity in seconds; the contract clamps it |

Mainnet `genesis` = `c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf`
(verified against live algod).

The three compile-time constants sit contiguously at 0–36, so a verifier checks
all three with one `extract 0 37` and one `==`. Every numeric field is exactly 8
bytes at a fixed offset, so `extract_uint64` applies uniformly and nothing does
partial-word extraction. **Measured: the whole bindings block costs 49 opcode
units, against 1900 for the signature.** There is no reordering worth a byte of
format churn.

### Upgrade rule — stated before anything freezes

**New fields append at the end. Existing offsets never move. `version` always
bumps. The version check is always `==`, never `>=`.** That last point is what
makes a prefix-extended v2 *unreadable* by a v1 verifier rather than silently
half-read.

## Everything trusted is inside the signature

The published JSON carries prices and ids too, but **for dashboards only**. No
verifier may read them. An attacker who can serve the bundle could pair a valid
signature with whatever JSON they liked — the trap
`oracle_bot.read_pex_algo_price` already exists to avoid, and a test asserts that
corrupting the envelope changes nothing a verifier concludes.

The bundle ships **no public key at all**. PEX's own bundle does ship
`pubkey_hex`, which is precisely that trap; ours does not offer the temptation.

## `lp_asa_id`, not `pool_id`

The field was called `pool_id`, and the values in use are in fact Tinyman v2 **LP
token ASA ids** — `3163770927` is the U/tALGO LP token, and the vault's own
`set_lp_asa_id` takes the same number. That identity holds only because Tinyman
v2 is 1:1 pool-to-LP-ASA. Add a Pact pool, or Tinyman v1, and "pool X" would stop
determining which ASA the price is denominated per unit of. A frozen field whose
name misdescribes its meaning is a bug generator for the life of the protocol.

## A band, not a point price

There is no "freshest available" rule and there cannot be one, so **every user
holds a free lookback option** for the life of a payload: a borrower submits the
one with the highest collateral price, a liquidator the lowest. Bounded by the
window, but systematically exploitable rather than occasional, and the thin pools
are where it bites. A band lets the vault value **collateral at `price_min` and
debt at `price_max`**, absorbing the option into the spread. PEX signs six such
bounds for the same reason.

`price_min == price_max` today. **The capacity is reserved, not yet used** — how
wide the band should be is a policy question needing its own evidence. 16 bytes
now costs nothing; adding them after deployment costs a migration.

## `issued_at` + a clamped `max_age`, not an absolute expiry

An absolute expiry would put the window in the **signer's** gift: a compromised
signer could mint a payload valid for a year. `issued_at` plus a contract-side
ceiling keeps it where a key holder cannot reach it. PEX does the same — their
signed bytes carry `publishedAt` while `valid_from`/`valid_until` live in the
unauthenticated envelope.

`max_age` is a **clamp**: the contract applies `min(PAYLOAD_MAX_AGE,
payload.max_age)`. A signer can only ask for a *shorter* life, never longer — so
the ceiling is unreachable from the key, while an honest signer can still say
"this one is worth less than usual": the TWAP is cold after a restart, a route
cross-check is missing, realised volatility just spiked.

**The age limit is needed even with a perfectly honest signer.** A signed payload
is public the moment it is used, so anyone — no key required — can keep a copy of
one signed during a price spike and replay it later. Arithmetic on public data.

### ⚠️ The chain clock runs BEHIND, so the real window is LONGER

`Global.latest_timestamp` is the **previous** block's timestamp — measured **~4s
behind wall clock** against a **~2.7s mean block interval**. So
`latest_timestamp - issued_at <= MAX_AGE` stays true until wall time
`issued_at + MAX_AGE + lag`.

**An earlier revision of this document had that backwards**, calling the window
shorter than it reads by one block. The expiry is the *only* replay defence in
v4, and this constant can afterwards be changed only by a vault migration, so the
direction is recorded deliberately.

The same arithmetic sets the forward tolerance: `issued_at <= latest_timestamp +
CLOCK_SKEW` gives a real tolerance of `CLOCK_SKEW - lag`, so a skew of 5 is
**~1–2 seconds** on chain — and a signer whose clock is 3s fast, ordinary NTP
drift on a VPS, would have payloads intermittently rejected for the first seconds
of their life.

### The constants, and where they came from

```python
PAYLOAD_MAX_AGE = 30     # payload.py
CLOCK_SKEW      = 0
```

Both follow **PEX's live configuration**, measured from their published bundle:
`max_age_seconds: 30`, `max_future_skew_seconds: 0`, publish cadence ~4–6s,
served `cache-control: no-cache, must-revalidate`. A future skew of zero works
because the lag already supplies the slack.

An earlier draft said "PEX validates for 20 seconds". That was wrong by a third,
and it was this design's only cited precedent. The same error sat in
`oracle_bot.py`'s comment on `PEX_MAX_AGE_SEC`; both are corrected.

**Copy their cache headers.** A CDN TTL on the bundle would silently eat the
window.

## What the vault must assert

Run the **bindings first, signature last**: measured at 49 units versus 1900, so
a misdirected payload fails for 49 and gives a clean error rather than a
budget-exceeded one.

1. `len(msg) == 85`, `extract 0 37 == MAGIC‖VERSION‖GENESIS`.
2. `target_app == Global.current_application_id`.
3. `lp_asa_id` is whitelisted **and** is the LP token of the pool being operated on.
4. `price_min > 0` and `price_max >= price_min`. A zero permanently bricks a pool
   (AUD-042); the signer refuses to sign one, but the contract must not depend on that.
5. `issued_at <= Global.latest_timestamp + CLOCK_SKEW`.
6. `Global.latest_timestamp - issued_at <= min(PAYLOAD_MAX_AGE, max_age)`.
7. **Then** `ed25519verify_bare` against the **pinned** public key — a contract
   constant, never anything from the bundle.

`payload.check_bindings` mirrors 1–6 so the two can be tested against each other,
and the price is unreachable in Python until it has run.

## Opcode budget — MEASURED, and it decides the group shape

All figures confirmed on mainnet via `/v2/transactions/simulate`, reading
`global OpcodeBudget` out of the AVM rather than inferring it. (`/v2/teal/dryrun`
is 404 on Algonode.)

| fact | measured |
|---|---|
| `ed25519verify_bare` | **exactly 1900** |
| budget per app call | **exactly 700**, pooling as 700 × n across top-level app calls |
| group cap | 16 txns → 11,200 max |
| **full verifier**, all 7 assertions above | **1953** |
| bindings alone (1–6) | **49** |
| inner no-op app call | **+683 net** each (700 added, ~17 burned), 1000 µALGO |
| LogicSig budget | **20,000 per group txn**, pooled, separate from the app pool |

**"Three app calls" is arithmetically right and operationally useless.** 2 calls
= 1400, fails. 3 calls = 2100, passes with **147 units left** for interest
accrual, box reads, LTV maths and inner transfers — 7% of the pool. 4 calls =
2800, leaving 847. **Four is the floor.** Anyone sizing the frontend's group from
"three" ships a design that reverts the first time the vault does real work.

PEX's own production group confirms the technique: 15 top-level txns, 14 app
calls, of which **11 are pure budget filler** (no-op calls, 1000 µALGO each),
3 carrying payload+signature, 9 inner calls — a 16,100 pool for 5,700 of
verification.

### Chosen shape: inner-call OpUp

The vault issues its **own** inner no-op app calls. The published group stays
**one transaction**, the frontend builds exactly one app call, and composing with
other protocols stays possible. Measured: 1 top-level + 3 inner = 2800 pool,
verify succeeds with 840 spare. Cost 1000 µALGO per inner call.

Rejected alternatives:

- **Filler app calls** (PEX's choice) — works, proven, but inflates every group
  to 4+ transactions and degrades wallet UX for no gain over inner calls.
- **LogicSig** — by far the cheapest place for the crypto (1900 against 20,000),
  but a logicsig cannot tell the app what it verified; binding them by group is
  more fragile.
- **Attestation call storing state** — **not needed**, and it would reintroduce
  stored state, which is what v4 exists to remove. If verify-once-use-many is
  ever wanted across several apps in one group, pass the verified price as an
  **inner-call ABI return value**, not global state: nothing persists, so nothing
  goes stale.

`extra-opcode-budget` is a **simulate-only** lever. It does not exist on
submission; it must not enter any design.

### One verify per consuming app

`target_app` binds to a single app, which is correct for safety and means each
app wanting the price pays its own 1900. Do **not** weaken it to a protocol-wide
id. If the vault, PSM and liquidation path all need the same price, have **one**
app verify and pass the result to the others as an inner-call ABI return value in
the same group.

## Bundle

One signed message **per pool**, in one JSON file published to object storage. A
consumer fetches it and carries only the payload for the pool it is touching; the
binding is in the signed bytes, so the JSON key is an index and nothing more.

```json
{
  "version": 1,
  "generated_at": 1791600000,
  "payloads": {
    "app-3671287267/lp-3163770927": {
      "message_hex": "...",
      "signature_hex": "...",
      "lp_asa_id": 3163770927, "price_min": 915905,
      "price_max": 915905, "issued_at": 1791600000, "max_age": 30
    }
  }
}
```

Everything after `signature_hex` is dashboard-only. `generated_at` lets a monitor
tell "the bundle is stale" from "this pool is missing" without decoding every
entry. Duplicate pools are refused at serialisation, because two payloads for one
pool make a consumer's choice undefined.

## Keys

- The signer key is **not an Algorand account**. In v4 the signer posts nothing on
  chain: it computes, signs, and pushes to storage. Needing no ALGO and signing
  no transactions closes the cross-protocol question outright, rather than resting
  on the fact that Algorand domain-prefixes transaction signing.
- The vault pins the signer's **public** key as a constant. Rotation is therefore
  a contract update — deliberately, since a settable signer key would make
  rotation an attack path.
- The signing host accepts **no inbound connections**.

## The magnitude guard that replaces the removed bounds

v4 removes per-pool `min_price`/`max_price` and `asset_price_bounds`, which would
leave `price > 0` as the only defence against a wrong *magnitude* — and a ×1e6 or
÷1e6 scaling slip is the most likely bug in this path. Note this codebase now
carries **two price scales**: 1e6 here, 1e12 for PEX payloads.

So `encode()` enforces a **wide** absolute band, `PRICE_SANITY_MIN = 1_000` to
`PRICE_SANITY_MAX = 1_000_000_000` — $0.001 to $1,000 per LP token. Live prices
are 862,635 to 2,528,944, and a ×1e6 slip lands at 9.2e11, caught.

This is not the band that rotted. That one was tight, per-pool and hand-maintained
at ±25%; this one needs no maintenance, and it is not a manipulation defence — the
TWAP and the route cross-checks are that. LP_ORACLE.md rejects a wide band on the
grounds that it "defends solely against key compromise", which has a gap: it also
defends against unit bugs, which is a different and still-live argument.

Enforced in `encode()` by the module's own doctrine — this is the last point at
which a bad value is still cheap, because past signing it is a bad value carrying
a good signature.

## Still to build

| piece | state |
|---|---|
| wire format + sign/verify/bundle | **done**, `signer/payload.py`, 59 tests |
| opcode-budget measurement | **done** — inner-call OpUp, 4 calls' worth of budget |
| publisher (storage upload, scheduling, cache headers) | not started; needs a bucket |
| vault verifier | not started |
| frontend payload fetch + group assembly | not started |
| band policy (how wide, when) | deferred; capacity reserved |

Pricing, TWAP smoothing and the route cross-checks are **not** rebuilt here — they
exist in `oracle_bot.py` with 111 tests. The signer reuses them; what is new is
this format, the signing step, and the upload.
