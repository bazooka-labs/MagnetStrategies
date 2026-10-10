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
    45      8     pool_id      so a payload for one pool cannot price another
    53      8     price        LP price in mUSD, scaled 1e6 (fixed by version)
    61      8     issued_at    unix seconds at signing; the CONTRACT applies
                               the max age — see below
    ------  ----
    69

Everything the verifier trusts is inside the signature. There is no JSON
envelope field the contract reads, because an attacker who can serve the bundle
could pair a valid signature with whatever JSON they liked — the mistake
`read_pex_algo_price` already exists to avoid.

── Why issued_at rather than expiry ──────────────────────────────────────────
Carrying an absolute expiry would put the validity window in the SIGNER's gift:
a compromised signer could mint a payload valid for a year. Carrying issued_at
and letting the contract enforce a constant maximum age keeps the window in the
contract, where a key holder cannot reach it.

That is defence in depth rather than a wall — a compromised signer can sign any
price it likes, so a long window is not its cheapest attack. It costs nothing,
so it is worth having.

── Why an age limit is needed even with an honest signer ─────────────────────
A signed payload is PUBLIC the moment it is used. Anyone, with no key at all,
can keep a copy of one signed during a price spike and replay it later. That is
arithmetic on public data, not a compromise, and it is why PEX validates for 20
seconds.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass

MAGIC = b"MFLP"            # MagnetFi LP Price
VERSION = 1
MSG_LEN = 69
PRICE_SCALE = 1_000_000    # fixed by VERSION; changing it needs a new version

# Network binding. Hex rather than base64 so it diffs readably and pastes into
# contract source without a decode step.
GENESIS_MAINNET = bytes.fromhex(
    "c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf"
)

_STRUCT = struct.Struct(">4sB32sQQQQ")
assert _STRUCT.size == MSG_LEN, (_STRUCT.size, MSG_LEN)

# u64 ceilings — encode must refuse rather than wrap. A wrapped price is a wrong
# price with a valid signature, which is the worst object this file could make.
_U64_MAX = (1 << 64) - 1


@dataclass(frozen=True)
class Payload:
    """A decoded price payload. Frozen so a verified payload cannot be edited."""
    target_app: int
    pool_id: int
    price: int
    issued_at: int
    genesis: bytes = GENESIS_MAINNET
    version: int = VERSION

    @property
    def price_usd(self) -> float:
        """Human-readable price. Never use for anything a decision depends on."""
        return self.price / PRICE_SCALE


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
    if p.price <= 0:
        # A zero permanently bricks a pool (AUD-042), and the contract rejects
        # it too. Refusing to sign one means it never reaches the chain.
        raise ValueError("price must be > 0")
    for name, v in (("target_app", p.target_app), ("pool_id", p.pool_id),
                    ("price", p.price), ("issued_at", p.issued_at)):
        if not isinstance(v, int) or isinstance(v, bool):
            raise TypeError(f"{name} must be an int, got {type(v).__name__}")
        if not 0 <= v <= _U64_MAX:
            raise ValueError(f"{name}={v} does not fit in a u64")
    return _STRUCT.pack(MAGIC, p.version, p.genesis,
                        p.target_app, p.pool_id, p.price, p.issued_at)


def decode(msg: bytes) -> Payload:
    """
    Parse the 69 signed bytes. Raises on any shape it does not recognise.

    Shape is checked BEFORE the signature elsewhere in the flow, so this must
    never accept a message it cannot fully account for — hence the exact length
    check rather than a prefix read.
    """
    if len(msg) != MSG_LEN:
        raise ValueError(f"expected {MSG_LEN} bytes, got {len(msg)}")
    magic, version, genesis, target_app, pool_id, price, issued_at = _STRUCT.unpack(msg)
    if magic != MAGIC:
        raise ValueError(f"bad magic {magic!r}, expected {MAGIC!r}")
    if version != VERSION:
        raise ValueError(f"unsupported version {version}")
    return Payload(target_app=target_app, pool_id=pool_id, price=price,
                   issued_at=issued_at, genesis=genesis, version=version)


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


def verify(msg: bytes, sig: bytes, public_key: bytes) -> Payload:
    """
    Verify `sig` over `msg` against a PINNED public key, then decode. Raises on
    failure; never returns an unverified payload.

    The key is a parameter and must come from a constant at the call site, never
    from the bundle. A payload's own embedded key only proves the message signed
    itself — the trap `read_pex_algo_price` documents.

    Note what this does NOT check: `target_app`, `pool_id`, `genesis` and the
    age. Those are policy, they differ between the vault and a monitor, and
    silently applying one caller's policy to another is how a verifier grows a
    hole. Use `check_bindings` for them.
    """
    import nacl.signing
    if len(public_key) != 32:
        raise ValueError(f"ed25519 public key must be 32 bytes, got {len(public_key)}")
    nacl.signing.VerifyKey(public_key).verify(msg, sig)   # raises BadSignatureError
    return decode(msg)


def check_bindings(p: Payload, *, target_app: int, pool_id: int, now: int,
                   max_age: int, genesis: bytes = GENESIS_MAINNET,
                   clock_skew: int = 5) -> None:
    """
    Apply the policy checks a consumer must make after `verify`. Raises on any
    failure.

    Separate from `verify` so the signature check cannot be accidentally
    satisfied by a payload that is authentic but for something else. This
    mirrors what the vault asserts on chain, and exists so the two can be
    tested against each other.
    """
    if p.genesis != genesis:
        raise ValueError("payload is bound to a different network")
    if p.target_app != target_app:
        raise ValueError(f"payload targets app {p.target_app}, not {target_app}")
    if p.pool_id != pool_id:
        raise ValueError(f"payload prices pool {p.pool_id}, not {pool_id}")
    if p.price <= 0:
        raise ValueError("price must be > 0")
    if p.issued_at > now + clock_skew:
        raise ValueError(f"payload is from the future ({p.issued_at} > {now})")
    if now - p.issued_at > max_age:
        raise ValueError(f"payload is {now - p.issued_at}s old, limit {max_age}s")


# ── bundle ────────────────────────────────────────────────────────────────────
#
# One signed message PER POOL, collected into a single JSON file. A consumer
# fetches the bundle and carries only the payload for the pool it is touching,
# so one pool's payload can never be mistaken for another's — the binding is in
# the signed bytes, and the key here is only an index.
#
# Shape mirrors PEX's own bundle so the frontend fetch can be modelled on the
# client that already reads theirs.

def bundle_key(target_app: int, pool_id: int) -> str:
    return f"app-{target_app}/pool-{pool_id}"


def make_bundle(signed: list[tuple[bytes, bytes]]) -> str:
    """
    Serialise (message, signature) pairs to the published JSON.

    Takes already-signed pairs rather than payloads, so this function cannot be
    the place a message and signature drift apart.
    """
    payloads: dict[str, dict] = {}
    for msg, sig in signed:
        p = decode(msg)               # re-decode: never index by a caller's claim
        key = bundle_key(p.target_app, p.pool_id)
        if key in payloads:
            raise ValueError(f"duplicate payload for {key}")
        payloads[key] = {
            "message_hex": msg.hex(),
            "signature_hex": sig.hex(),
            # Envelope extras are for humans and dashboards ONLY. No verifier
            # may read them — see the module docstring.
            "pool_id": p.pool_id,
            "price": p.price,
            "issued_at": p.issued_at,
        }
    return json.dumps({"version": VERSION, "payloads": payloads}, indent=1, sort_keys=True)
