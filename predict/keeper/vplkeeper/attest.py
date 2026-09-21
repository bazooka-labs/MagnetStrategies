"""The signed attestation.

This preimage must match the contract's reconstruction byte for byte. If it drifts,
every submission fails signature verification and every round voids — so the contract
is the source of truth and this is the mirror, not the other way round.

Field provenance matters as much as the layout. On-chain, `app_id` comes from Global,
`round_id` from the box key, `checkpoint_kind` from the calling method's own literal,
and `price_feed_id` from the round's snapshot. Only the mask, prices and timestamps
come from call arguments. A keeper that got any of the first four wrong would produce
signatures that verify against nothing.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

CHECKPOINT_LOCK = 0
CHECKPOINT_RESOLVE = 1


def preimage(
    app_id: int,
    round_id: int,
    checkpoint_kind: int,
    present_mask: int,
    price_feed_id: int,
    prices: list[int],
    timestamps: list[int],
) -> bytes:
    """104 bytes: five uint64 scalars, then two 4-slot uint64 arrays."""
    if len(prices) != 4 or len(timestamps) != 4:
        raise ValueError("prices and timestamps must be 4 slots each")
    if not 0 < present_mask <= 0x0F:
        raise ValueError(f"mask out of range: {present_mask:#x}")
    parts = [
        app_id, round_id, checkpoint_kind, present_mask, price_feed_id,
        *prices, *timestamps,
    ]
    return b"".join(x.to_bytes(8, "big") for x in parts)


def sign(signing_key, **kw) -> bytes:
    """Sign sha256(preimage). ed25519verify_bare takes the digest, not the message."""
    return signing_key.sign(hashlib.sha256(preimage(**kw)).digest()).signature


@dataclass(frozen=True)
class Attestation:
    """One signed checkpoint. Persist this the moment it is produced.

    Signing twice for the same (round_id, checkpoint_kind) is the single obligation the
    contract cannot enforce: both signatures verify, both are public once published,
    and lock/resolve are permissionless — so a participant picks whichever median lands
    in their band. On any retry, resubmit these exact bytes. Never re-sign.
    """

    round_id: int
    checkpoint_kind: int
    present_mask: int
    prices: list[int]
    timestamps: list[int]
    signature: bytes

    @property
    def key(self) -> tuple[int, int]:
        return (self.round_id, self.checkpoint_kind)


class AttestationStore:
    """Enforces sign-once by construction.

    Deliberately not a cache: a miss must be a *signing* event and a hit must return
    the original bytes unchanged. The in-memory version below is a reference; the
    running keeper needs this durable, because the failure it guards against is
    precisely a crash between signing and submitting.
    """

    def __init__(self) -> None:
        self._by_key: dict[tuple[int, int], Attestation] = {}

    def get_or_sign(
        self, signing_key, app_id: int, round_id: int, checkpoint_kind: int,
        price_feed_id: int, prices: list[int], timestamps: list[int],
        present_mask: int,
    ) -> Attestation:
        key = (round_id, checkpoint_kind)
        if key in self._by_key:
            return self._by_key[key]
        sig = sign(
            signing_key, app_id=app_id, round_id=round_id,
            checkpoint_kind=checkpoint_kind, present_mask=present_mask,
            price_feed_id=price_feed_id, prices=prices, timestamps=timestamps,
        )
        att = Attestation(round_id, checkpoint_kind, present_mask,
                          list(prices), list(timestamps), sig)
        self._by_key[key] = att
        return att
