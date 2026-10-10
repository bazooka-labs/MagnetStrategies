"""
MagnetFi v4 signed LP-price payloads — encode, sign, verify.

This module is the single definition of the wire format. The vault's verifier and
this file must agree BYTE FOR BYTE, so the layout lives here, in one table, with
the reasoning next to it. Nothing here touches the network, the filesystem or
the chain: it is pure bytes so it can be tested exhaustively, and so the vault
implementation can be checked against it offline.

── Why signed payloads at all ────────────────────────────────────────────────
See LP_ORACLE.md "v4 — Signed Payloads". In one line: the protocol was heavily
defended against a stolen bot key and barely at all against the oracle simply
stopping, and stopping is the failure that has actually happened, three times.
Nothing posted on chain means nothing to go stale.

── Layout, 69 bytes, big-endian ──────────────────────────────────────────────

    offset  size  field        why it is in the signed bytes
    ------  ----  -----------  --------------------------------------------
    0       4     magic        domain separation: this key must never sign
                               something another verifier could read as a
                               price, nor vice versa
    4       1     version      lets the format change without ambiguity
    5       32    genesis      binds to one network; a testnet payload is not
                               a mainnet payload even if the key is reused
    37      8     target_app   binds to ONE vault app id, so a payload cannot
                               be replayed against another deployment
    45      8     lp_asa_id    the LP TOKEN ASA this price is per unit of
    53      8     price_min    low end of the signed band, mUSD scaled 1e6
    61      8     price_max    high end; equal to price_min today
    69      8     issued_at    unix seconds at signing
    77      8     max_age      signer's requested validity, in seconds; the
                               contract CLAMPS it — see below
    ------  ----
    85

All three compile-time constants sit contiguously at 0..36, so a verifier
checks magic+version+genesis with one `extract 0 37` and one `==` rather than
three separate reads. Every numeric field is exactly 8 bytes at a fixed offset,
so `extract_uint64` applies uniformly and there is no partial-word extraction
anywhere. Measured: the whole bindings block costs 49 opcode units against
1900 for the signature.

── Why lp_asa_id and not pool_id ─────────────────────────────────────────────
It was called `pool_id` and the values are in fact Tinyman v2 LP token ASA ids
(3163770927 is the U/tALGO LP token, and the vault's own `set_lp_asa_id` takes
the same number). That identity holds only because Tinyman v2 is 1:1
pool-to-LP-ASA. Add a Pact pool, or Tinyman v1, and "pool X" would stop
determining which ASA the price is denominated per unit of. A frozen field whose
name misdescribes its meaning is a bug generator for the life of the protocol,
so it says what it is.

── Why a band rather than a point price ──────────────────────────────────────
There is no "freshest available" rule and there cannot be one, so every user
holds a free lookback option for the life of a payload: a borrower submits the
one with the highest collateral price, a liquidator the lowest. Bounded by the
window, but systematically exploitable rather than occasional, and the thin
pools are where it bites. A band lets the vault value COLLATERAL at price_min
and DEBT at price_max, absorbing the option into the spread. PEX signs six such
bounds for the same reason.

`price_min == price_max` today — the capacity is reserved, not yet used, because
how wide the band should be is a policy question that needs its own evidence.
Reserving 16 bytes now costs nothing; adding them after a verifier is deployed
costs a vault migration, and the vault is the one contract with no repointing
path.

── Why max_age is a CLAMP and not a setting ──────────────────────────────────
The contract applies `min(PAYLOAD_MAX_AGE, payload.max_age)`. A signer can only
ever ASK for a shorter life, never a longer one, so the ceiling stays somewhere
a key holder cannot reach — while an honest signer can still say "this one is
worth less than usual": the TWAP is cold after a restart, a route cross-check
is missing, realised volatility just spiked.

Everything the verifier trusts is inside the signature. There is no JSON
envelope field the contract reads, because an attacker who can serve the bundle
could pair a valid signature with whatever JSON they liked — the mistake
`read_pex_algo_price` already exists to avoid.

── Why issued_at rather than an absolute expiry ──────────────────────────────
An absolute expiry would put the window in the SIGNER's gift: a compromised
signer could mint a payload valid for a year. issued_at plus a contract-side
ceiling keeps it where a key holder cannot reach it. PEX does the same — their
signed bytes carry publishedAt, while valid_from/valid_until live in the
unauthenticated envelope.

── Why an age limit is needed even with an honest signer ─────────────────────
A signed payload is PUBLIC the moment it is used. Anyone, with no key at all,
can keep a copy of one signed during a price spike and replay it later. That is
arithmetic on public data, not a compromise.

── The on-chain clock runs BEHIND, so the real window is LONGER ──────────────
`Global.latest_timestamp` is the PREVIOUS block's timestamp, measured ~4s
behind wall clock against a ~2.7s mean block interval. So
`latest_timestamp - issued_at <= MAX_AGE` stays true until wall time
`issued_at + MAX_AGE + lag`: a 20s constant is a ~23-24s real replay window.

An earlier version of this file had that backwards and called the window
SHORTER than it reads. The expiry is the only replay defence in v4, and this
constant can afterwards be changed only by a vault migration, so the direction
is written down deliberately.

For the same reason CLOCK_SKEW is not small: `issued_at <= latest_timestamp +
skew` means the real forward tolerance is `skew - lag`, so a skew of 5 is
~1-2 seconds on chain, and a signer whose clock is 3s fast — ordinary NTP drift
— would have its payloads intermittently rejected for the first seconds of
their life. PEX runs a future skew of ZERO precisely because the lag already
supplies the slack.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass

MAGIC = b"MFLP"            # MagnetFi LP Price
VERSION = 1
MSG_LEN = 85

# Fixed by VERSION, deliberately NOT a field in the payload: a scale field would
# hand the signer a free 1e6x multiplier on every price. PEX uses 1e12 for its
# own payloads, so this codebase carries two scales across two formats — which is
# exactly the unit confusion PRICE_SANITY_* below exists to catch.
#
# 1e6 also keeps `lp_amount * price` inside one word (1e12 * 2.5e6 < 1.8e19), so
# collateral valuation needs no mulw/divw.
PRICE_SCALE = 1_000_000

# The validity window, defined HERE rather than only in prose, because these are
# the two numbers the on-chain verifier will freeze.
#
# 30/0 follows PEX's live configuration (max_age_seconds 30, max_future_skew 0),
# measured from their published bundle. An earlier draft said "PEX validates for
# 20 seconds", which was wrong by 33% and was this design's only cited
# precedent. Remember the chain clock runs ~4s behind, so 30 is a ~33-34s real
# window and a skew of 0 still tolerates a signer a few seconds fast.
PAYLOAD_MAX_AGE = 30
CLOCK_SKEW = 0

# Wide absolute sanity band, in scaled units: $0.001 .. $1,000 per LP token.
#
# v4 removes the per-pool min_price/max_price and asset_price_bounds, which
# leaves `price > 0` as the ONLY guard against a magnitude error. A x1e6 or
# /1e6 scaling slip is the most likely bug in this path and would otherwise be
# signed and accepted: live LP prices are 9.2e5..2.5e6, and a x1e6 slip lands at
# 9.2e11, which this catches.
#
# Deliberately WIDE. The band that rotted was the tight per-pool one, hand
# maintained at +/-25%; this one needs no maintenance and is not a defence
# against manipulation — the TWAP and the route cross-checks are that.
PRICE_SANITY_MIN = 1_000
PRICE_SANITY_MAX = 1_000_000_000

# Network binding. Hex rather than base64 so it diffs readably and pastes into
# contract source without a decode step.
GENESIS_MAINNET = bytes.fromhex(
    "c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf"
)

_STRUCT = struct.Struct(">4sB32sQQQQQQ")
assert _STRUCT.size == MSG_LEN, (_STRUCT.size, MSG_LEN)

# u64 ceilings — encode must refuse rather than wrap. A wrapped price is a wrong
# price with a valid signature, which is the worst object this file could make.
_U64_MAX = (1 << 64) - 1


@dataclass(frozen=True)
class Payload:
    """A decoded, BOUND price payload. Frozen so it cannot be edited after checks."""
    target_app: int
    lp_asa_id: int
    price_min: int
    price_max: int
    issued_at: int
    max_age: int = PAYLOAD_MAX_AGE
    genesis: bytes = GENESIS_MAINNET
    version: int = VERSION

    @property
    def price_musd(self) -> float:
        """
        Human-readable mid. Never use for anything a decision depends on.

        mUSD, not USD — collateral and debt are both mUSD-denominated, which is
        self-consistent, but a name saying "usd" would mislead the day mUSD
        depegs.
        """
        return (self.price_min + self.price_max) / 2 / PRICE_SCALE


@dataclass(frozen=True)
class UnboundPayload:
    """
    A payload whose SIGNATURE is verified and whose bindings are not.

    It deliberately exposes no price. `verify()` used to return a full Payload,
    which made `use(verify(msg, sig, KEY).price)` the shortest thing to write —
    compiling, passing tests, and consuming a payload that might be for another
    network, another vault, another pool, and arbitrarily stale. A docstring
    warned; nothing enforced it. Now the price is unreachable until
    `check_bindings` has run, so the split survives and the hazard does not.
    """
    _p: Payload

    @property
    def issued_at(self) -> int:
        """Exposed because a monitor may legitimately report age before binding."""
        return self._p.issued_at


def encode(p: Payload) -> bytes:
    """
    Serialise to the 69 signed bytes. Raises on anything unrepresentable.

    Validation is strict and happens HERE rather than at the call site, because
    this is the last point at which a bad value is still cheap: past the signing
    step it is a bad value carrying a good signature.
    """
    if p.version != VERSION:
        raise ValueError(f"version {p.version} is not {VERSION}; use the matching encoder")
    if len(p.genesis) != 32:
        raise ValueError(f"genesis must be 32 bytes, got {len(p.genesis)}")
    for name, v in (("target_app", p.target_app), ("lp_asa_id", p.lp_asa_id),
                    ("price_min", p.price_min), ("price_max", p.price_max),
                    ("issued_at", p.issued_at), ("max_age", p.max_age)):
        if not isinstance(v, int) or isinstance(v, bool):
            # bool IS an int in Python, so True would quietly encode as 1.
            raise TypeError(f"{name} must be an int, got {type(v).__name__}")
        if not 0 <= v <= _U64_MAX:
            raise ValueError(f"{name}={v} does not fit in a u64")
    if p.price_min <= 0:
        # A zero permanently bricks a pool (AUD-042). The contract rejects it
        # too; refusing to SIGN one means it never reaches the chain.
        raise ValueError("price_min must be > 0")
    if p.price_max < p.price_min:
        raise ValueError(f"price_max {p.price_max} < price_min {p.price_min}")
    for name, v in (("price_min", p.price_min), ("price_max", p.price_max)):
        if not PRICE_SANITY_MIN <= v <= PRICE_SANITY_MAX:
            raise ValueError(
                f"{name}={v} outside the sanity band "
                f"[{PRICE_SANITY_MIN}, {PRICE_SANITY_MAX}] — a scaling error?")
    if p.max_age <= 0:
        raise ValueError("max_age must be > 0, else the payload is born expired")
    if p.max_age > PAYLOAD_MAX_AGE:
        # The signer may only ever ASK for a shorter life. Refusing here means a
        # longer-than-ceiling request never even gets signed.
        raise ValueError(f"max_age {p.max_age} exceeds the ceiling {PAYLOAD_MAX_AGE}")
    return _STRUCT.pack(MAGIC, p.version, p.genesis, p.target_app, p.lp_asa_id,
                        p.price_min, p.price_max, p.issued_at, p.max_age)


def decode(msg: bytes) -> Payload:
    """
    Parse the 69 signed bytes. Raises on any shape it does not recognise.

    Shape is checked BEFORE the signature elsewhere in the flow, so this must
    never accept a message it cannot fully account for — hence the exact length
    check rather than a prefix read.
    """
    if len(msg) != MSG_LEN:
        raise ValueError(f"expected {MSG_LEN} bytes, got {len(msg)}")
    (magic, version, genesis, target_app, lp_asa_id,
     price_min, price_max, issued_at, max_age) = _STRUCT.unpack(msg)
    if magic != MAGIC:
        raise ValueError(f"bad magic {magic!r}, expected {MAGIC!r}")
    # `!=`, never `>=`. This is what makes a prefix-extended v2 unreadable by a
    # v1 verifier rather than silently half-read. See the upgrade rule in
    # SIGNED_PAYLOAD.md: new fields append at the end, offsets never move,
    # version always bumps, the check is always `==`.
    if version != VERSION:
        raise ValueError(f"unsupported version {version}")
    return Payload(target_app=target_app, lp_asa_id=lp_asa_id,
                   price_min=price_min, price_max=price_max,
                   issued_at=issued_at, max_age=max_age,
                   genesis=genesis, version=version)


def sign(p: Payload, signing_key: bytes) -> tuple[bytes, bytes]:
    """
    Return (message, signature). `signing_key` is a 32-byte ed25519 seed.

    Returns the message too, so a caller cannot sign one set of bytes and
    publish another — the pairing is produced in one place.
    """
    import nacl.signing
    if len(signing_key) != 32:
        raise ValueError(f"ed25519 seed must be 32 bytes, got {len(signing_key)}")
    msg = encode(p)
    sig = nacl.signing.SigningKey(signing_key).sign(msg).signature
    return msg, sig


def verify(msg: bytes, sig: bytes, public_key: bytes) -> UnboundPayload:
    """
    Verify `sig` over `msg` against a PINNED public key. Raises on failure.

    Returns an `UnboundPayload`, which carries no price: the bindings are not
    checked yet, and a payload can be perfectly authentic while being for
    another network, another vault, another pool, or half a minute stale. Pass
    the result to `check_bindings` to get at the price.

    The key is a parameter and must come from a constant at the call site, never
    from the bundle. A payload's own embedded key only proves the message signed
    itself — the trap `read_pex_algo_price` documents, and the reason this
    format ships no pubkey in its bundle at all.

    ON CHAIN, run the bindings FIRST: measured, the whole bindings block costs
    49 opcode units against 1900 for this signature, so a misdirected payload
    should fail for 49 and give a clean error rather than a budget-exceeded one.
    Here the order is reversed only because decode() must run before the fields
    exist to check.
    """
    import nacl.signing
    if len(public_key) != 32:
        raise ValueError(f"ed25519 public key must be 32 bytes, got {len(public_key)}")
    nacl.signing.VerifyKey(public_key).verify(msg, sig)   # raises BadSignatureError
    return UnboundPayload(decode(msg))


def check_bindings(u: UnboundPayload, *, target_app: int, lp_asa_id: int, now: int,
                   max_age: int = PAYLOAD_MAX_AGE, genesis: bytes = GENESIS_MAINNET,
                   clock_skew: int = CLOCK_SKEW) -> Payload:
    """
    Apply the policy checks and return the bound `Payload`. Raises on any failure.

    Separate from `verify` so a signature check cannot be accidentally satisfied
    by a payload that is authentic but for something else — and the price is
    unreachable until this has run, so the separation is structural rather than
    advisory. Mirrors what the vault asserts on chain so the two can be tested
    against each other.

    `max_age` defaults to the ceiling rather than being a required argument: a
    monitor passing 3600 would otherwise conclude a payload is fine that the
    vault would reject.
    """
    p = u._p
    if p.genesis != genesis:
        raise ValueError("payload is bound to a different network")
    if p.target_app != target_app:
        raise ValueError(f"payload targets app {p.target_app}, not {target_app}")
    if p.lp_asa_id != lp_asa_id:
        raise ValueError(f"payload prices LP ASA {p.lp_asa_id}, not {lp_asa_id}")
    if p.price_min <= 0:
        raise ValueError("price_min must be > 0")
    if p.price_max < p.price_min:
        raise ValueError("price_max < price_min")
    if p.issued_at > now + clock_skew:
        raise ValueError(f"payload is from the future ({p.issued_at} > {now})")
    # The signer may ask for less than the ceiling, never more. min() is the
    # clamp: a compromised key cannot extend its own payloads' lives.
    effective = min(max_age, p.max_age)
    if now - p.issued_at > effective:
        raise ValueError(f"payload is {now - p.issued_at}s old, limit {effective}s")
    return p


# ── bundle ────────────────────────────────────────────────────────────────────
#
# One signed message PER POOL, collected into a single JSON file. A consumer
# fetches the bundle and carries only the payload for the pool it is touching,
# so one pool's payload can never be mistaken for another's — the binding is in
# the signed bytes, and the key here is only an index.
#
# Shape mirrors PEX's own bundle so the frontend fetch can be modelled on the
# client that already reads theirs.

def bundle_key(target_app: int, lp_asa_id: int) -> str:
    return f"app-{target_app}/lp-{lp_asa_id}"


def make_bundle(signed: list[tuple[bytes, bytes]], *, generated_at: int | None = None) -> str:
    """
    Serialise (message, signature) pairs to the published JSON.

    Takes already-signed pairs rather than payloads, so this function cannot be
    the place a message and signature drift apart.
    """
    payloads: dict[str, dict] = {}
    for msg, sig in signed:
        p = decode(msg)               # re-decode: never index by a caller's claim
        key = bundle_key(p.target_app, p.lp_asa_id)
        if key in payloads:
            raise ValueError(f"duplicate payload for {key}")
        payloads[key] = {
            "message_hex": msg.hex(),
            "signature_hex": sig.hex(),
            # Envelope extras are for humans and dashboards ONLY. No verifier
            # may read them — see the module docstring. A test asserts that
            # corrupting them changes nothing a verifier concludes.
            "lp_asa_id": p.lp_asa_id,
            "price_min": p.price_min,
            "price_max": p.price_max,
            "issued_at": p.issued_at,
            "max_age": p.max_age,
        }
    # generated_at lets a monitor tell "the bundle is stale" from "this pool is
    # missing" without decoding every entry. Unauthenticated, like the rest of
    # the envelope. PEX publish theirs the same way.
    out = {"version": VERSION, "payloads": payloads}
    if generated_at is not None:
        out["generated_at"] = generated_at
    return json.dumps(out, indent=1, sort_keys=True)
