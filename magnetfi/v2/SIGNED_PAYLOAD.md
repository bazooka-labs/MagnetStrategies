# MagnetFi v4 — Signed Price Payload Format

**Status: format defined and tested; the vault verifier and the publisher are not
built.** Rationale for the whole approach is in
[LP_ORACLE.md → v4](./LP_ORACLE.md#v4--signed-payloads-decided-2026-10-07-not-yet-built).
This document is the contract between the signer and the vault, and the two must
agree **byte for byte**.

Reference implementation: `magnetfi/v2/signer/payload.py` (36 tests). Nothing
imports it yet, so changing it today is free. That stops being true the moment a
verifier is deployed.

## Layout — 69 bytes, big-endian

| offset | size | field | why it is inside the signature |
|---|---|---|---|
| 0 | 4 | `magic` = `MFLP` | domain separation: this key must never sign something another verifier could read as a price, nor the reverse |
| 4 | 1 | `version` = 1 | lets the format change without ambiguity |
| 5 | 32 | `genesis` | binds to one network — a testnet payload is not a mainnet payload even if a key is reused |
| 37 | 8 | `target_app` | binds to **one** vault app id, so a payload cannot be replayed against another deployment |
| 45 | 8 | `pool_id` | so a payload for one pool cannot price another |
| 53 | 8 | `price` | LP price in mUSD, scaled `1e6`, fixed by `version` |
| 61 | 8 | `issued_at` | unix seconds at signing; the **contract** applies the max age |

Mainnet `genesis` = `c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf`.

Frozen vector (vault `3671287267`, pool `3163770927`, price `915905`, issued `1791600000`):

```
4d464c5001c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf
00000000dad365e300000000bc93502f00000000000df9c1000000006ac9a580
```

## Everything trusted is inside the signature

The published JSON carries `pool_id`, `price` and `issued_at` **for dashboards
only**. No verifier may read them. An attacker who can serve the bundle could
pair a valid signature with whatever JSON they liked — the exact trap
`oracle_bot.read_pex_algo_price` already exists to avoid, and a test asserts
that corrupting the envelope changes nothing a verifier concludes.

## `issued_at`, not `expiry`

An absolute expiry would put the validity window in the **signer's** gift: a
compromised signer could mint a payload valid for a year. Carrying `issued_at`
and letting the contract enforce a constant maximum age keeps the window
somewhere a key holder cannot reach.

This is defence in depth, not a wall — a compromised signer can sign any price
it likes, so a long window is not its cheapest attack. It costs nothing, so it
is worth having.

**The age limit is needed even with a perfectly honest signer.** A signed payload
is public the moment it is used, so anyone — no key required — can keep a copy of
one signed during a price spike and replay it later. That is arithmetic on public
data, not a compromise. It is why PEX validates for 20 seconds.

## What the vault must assert

Signature first is **not** sufficient; a payload can be authentic and still be
for something else. `payload.check_bindings` mirrors this list so the two can be
tested against each other.

1. `ed25519` signature verifies against the **pinned** public key — a constant in
   the contract, never anything from the bundle.
2. `len(msg) == 69`, `magic == "MFLP"`, `version == 1`.
3. `genesis` equals mainnet's.
4. `target_app == Global.current_application_id`.
5. `pool_id` is whitelisted **and** is the pool the call is operating on.
6. `price > 0` — a zero permanently bricks a pool (AUD-042). The signer refuses
   to sign one, but the contract must not depend on that.
7. `issued_at <= now + CLOCK_SKEW` (not from the future) and
   `now - issued_at <= PAYLOAD_MAX_AGE`.

Suggested constants: `PAYLOAD_MAX_AGE = 20`, `CLOCK_SKEW = 5`. Note `now` is
`Global.latest_timestamp`, which is the **previous** block's timestamp — so the
effective window is shorter than it reads by roughly one block.

## ⚠️ Open question — opcode budget

**This must be settled before the vault is written, because it decides the shape
of every transaction group the frontend builds.**

`ed25519verify_bare` is the right primitive (it verifies over the raw message;
plain `ed25519verify` prepends `ProgData` + the app address, which would mean the
signer could not produce a payload portable to an off-chain verifier).

Its documented cost is **1900** opcode budget units, against **700** per app call.
Budget pools across app calls in a group, so a single verify appears to need
**three** app calls in the group to afford it.

Consequences if that holds:

- every borrow, repay and liquidation group grows by filler app calls, or
- the verify is done once in a cheap "price attestation" call whose result is
  stashed for the real call to read — which reintroduces stored state and some of
  what v4 exists to remove, or
- a logic-signature verifies instead, moving the cost outside the app budget.

**Not verified.** No MagnetFi contract uses a crypto opcode today, so there is no
in-repo precedent, and the figure above is from documentation rather than
measurement. Measure it against the live AVM — a throwaway app plus `simulate`
reports the consumed budget directly — before committing to a group shape. PEX
already does on-chain verification of this exact payload style, so their
transaction shape is the cheapest available evidence for how it is done.

## Bundle

One signed message **per pool**, collected in one JSON file published to object
storage. A consumer fetches the bundle and carries only the payload for the pool
it is touching; the binding is in the signed bytes, so the JSON key is an index
and nothing more. Shape mirrors PEX's own bundle so the frontend fetch can be
modelled on the client that already reads theirs.

```json
{
  "version": 1,
  "payloads": {
    "app-3671287267/pool-3163770927": {
      "message_hex": "...",
      "signature_hex": "...",
      "pool_id": 3163770927, "price": 915905, "issued_at": 1791600000
    }
  }
}
```

The last three keys are the dashboard-only extras. Duplicate pools are refused at
serialisation, because two payloads for one pool make a consumer's choice
undefined.

## Keys

- Signer key is **separate from the cold admin key** and holds only fee ALGO. It
  can sign prices and nothing else; it cannot move funds, change risk parameters,
  or pause.
- The vault pins the signer's **public** key as a constant. Rotation is therefore
  a contract update — deliberately, since a settable signer key would make key
  rotation an attack path.
- The signing host accepts **no inbound connections**: it computes, signs, and
  pushes outward to storage.

## Still to build

| piece | state |
|---|---|
| wire format + sign/verify/bundle | **done**, `signer/payload.py`, 36 tests |
| opcode-budget measurement | **open — blocks the vault** |
| publisher (storage upload, scheduling) | not started; needs a bucket |
| vault verifier | not started; blocked on the budget question |
| frontend payload fetch + group assembly | not started |

Pricing, TWAP smoothing and the route cross-checks are **not** rebuilt here —
they already exist in `oracle_bot.py` and carry 111 tests. The signer reuses
them; what is new is only this format, the signing step, and the upload.
