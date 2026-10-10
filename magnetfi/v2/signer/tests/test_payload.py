"""
Tests for the v4 signed-payload wire format.

The vault's verifier must agree with payload.py byte for byte, so these pin the
format itself — magic, length, offsets, endianness — not just round-tripping.
A round-trip test alone would pass on a format both sides got wrong together.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import payload as pl                                             # noqa: E402

SEED = bytes(range(32))          # deterministic, so the vectors below are stable
VAULT = 3_671_287_267
POOL = 3_163_770_927


def make(**over) -> pl.Payload:
    d = dict(target_app=VAULT, pool_id=POOL, price=915_905, issued_at=1_791_600_000)
    d.update(over)
    return pl.Payload(**d)


def pub() -> bytes:
    import nacl.signing
    return bytes(nacl.signing.SigningKey(SEED).verify_key)


# ── the format itself ─────────────────────────────────────────────────────────

def test_message_is_exactly_69_bytes():
    assert len(pl.encode(make())) == pl.MSG_LEN == 69


def test_field_offsets_are_what_the_contract_will_read():
    """
    Pinned by OFFSET, not by round-trip. The vault reads these positions with
    extract_uint64, so a field moving is a silent misprice, and a round-trip
    test would not notice.
    """
    msg = pl.encode(make())
    assert msg[0:4] == b"MFLP"
    assert msg[4] == 1
    assert msg[5:37] == pl.GENESIS_MAINNET
    assert int.from_bytes(msg[37:45], "big") == VAULT
    assert int.from_bytes(msg[45:53], "big") == POOL
    assert int.from_bytes(msg[53:61], "big") == 915_905
    assert int.from_bytes(msg[61:69], "big") == 1_791_600_000


def test_integers_are_big_endian():
    """Little-endian would decode 915,905 as 1.3e16 — a valid-looking disaster."""
    msg = pl.encode(make(price=1))
    assert msg[53:61] == b"\x00\x00\x00\x00\x00\x00\x00\x01"


def test_known_vector_is_stable():
    """
    A frozen regression vector, generated once from the encoder and pinned here.

    It deliberately does NOT carry its own semantics — generating a vector from
    the code and asserting the code matches it would be circular. What it
    catches is the format CHANGING: once a verifier is deployed, any change to
    these bytes breaks it, so the change must be a deliberate act with a version
    bump rather than the side effect of an edit.

    The semantic check is test_field_offsets_are_what_the_contract_will_read,
    whose slice positions and expected integers are written by hand and so are
    independent of the encoder. (Mine were wrong on the first attempt here —
    two fields hand-computed incorrectly — which is exactly why the offset test
    is the one that carries the meaning.)
    """
    assert pl.encode(make()).hex() == (
        "4d464c50"                                                           # magic
        "01"                                                                 # version
        "c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf"   # genesis
        "00000000dad365e3"                                                   # target_app
        "00000000bc93502f"                                                   # pool_id
        "00000000000df9c1"                                                   # price
        "000000006ac9a580"                                                   # issued_at
    )


def test_roundtrip():
    p = make()
    assert pl.decode(pl.encode(p)) == p


def test_price_usd_is_scaled():
    assert make(price=915_905).price_usd == pytest.approx(0.915905)


# ── encode refuses what it cannot represent ───────────────────────────────────

def test_encode_refuses_zero_price():
    """A zero permanently bricks a pool (AUD-042). Never sign one."""
    with pytest.raises(ValueError, match="price must be > 0"):
        pl.encode(make(price=0))


def test_encode_refuses_negative_price():
    with pytest.raises(ValueError, match="price must be > 0"):
        pl.encode(make(price=-1))


def test_encode_refuses_values_too_big_for_u64():
    """A wrapped value is a wrong price with a VALID signature."""
    with pytest.raises(ValueError, match="u64"):
        pl.encode(make(price=1 << 64))
    with pytest.raises(ValueError, match="u64"):
        pl.encode(make(pool_id=1 << 64))


def test_encode_refuses_a_bool_masquerading_as_an_int():
    """bool is an int in Python; True would silently encode as price 1."""
    with pytest.raises(TypeError):
        pl.encode(make(price=True))


def test_encode_refuses_a_wrong_length_genesis():
    with pytest.raises(ValueError, match="32 bytes"):
        pl.encode(make(genesis=b"\x00" * 31))


def test_encode_refuses_an_unknown_version():
    with pytest.raises(ValueError, match="version"):
        pl.encode(make(version=2))


# ── decode rejects anything it cannot fully account for ───────────────────────

@pytest.mark.parametrize("n", [0, 1, 68, 70, 133])
def test_decode_refuses_wrong_lengths(n):
    with pytest.raises(ValueError, match="bytes"):
        pl.decode(b"\x00" * n)


def test_decode_refuses_foreign_magic():
    """A PEX payload is 133 bytes of PDX2 — it must never read as a price here."""
    msg = bytearray(pl.encode(make()))
    msg[0:4] = b"PDX2"
    with pytest.raises(ValueError, match="magic"):
        pl.decode(bytes(msg))


def test_decode_refuses_a_future_version():
    msg = bytearray(pl.encode(make()))
    msg[4] = 2
    with pytest.raises(ValueError, match="version"):
        pl.decode(bytes(msg))


# ── signature ─────────────────────────────────────────────────────────────────

def test_sign_then_verify_roundtrips():
    msg, sig = pl.sign(make(), SEED)
    assert pl.verify(msg, sig, pub()) == make()


def test_verify_rejects_a_tampered_message():
    from nacl.exceptions import BadSignatureError
    msg, sig = pl.sign(make(), SEED)
    for i in (0, 4, 40, 53, 60, 68):          # magic, version, app, price, issued_at
        bad = bytearray(msg)
        bad[i] ^= 0x01
        with pytest.raises(BadSignatureError):
            pl.verify(bytes(bad), sig, pub())


def test_verify_rejects_a_tampered_signature():
    from nacl.exceptions import BadSignatureError
    msg, sig = pl.sign(make(), SEED)
    bad = bytearray(sig); bad[0] ^= 0x01
    with pytest.raises(BadSignatureError):
        pl.verify(msg, bytes(bad), pub())


def test_verify_rejects_another_signers_key():
    """The pinned key is the whole point: a valid signature is not enough."""
    import nacl.signing
    from nacl.exceptions import BadSignatureError
    other = bytes(nacl.signing.SigningKey(bytes(range(1, 33))).verify_key)
    msg, sig = pl.sign(make(), SEED)
    with pytest.raises(BadSignatureError):
        pl.verify(msg, sig, other)


def test_sign_refuses_a_wrong_length_seed():
    with pytest.raises(ValueError, match="32 bytes"):
        pl.sign(make(), b"short")


def test_sign_returns_the_bytes_it_signed():
    """So a caller cannot sign one message and publish a different one."""
    msg, sig = pl.sign(make(), SEED)
    assert msg == pl.encode(make())
    assert len(sig) == 64


# ── bindings: authentic but for something else ────────────────────────────────

def ok(**over):
    d = dict(target_app=VAULT, pool_id=POOL, now=1_791_600_010, max_age=20)
    d.update(over)
    return d


def test_bindings_accept_a_matching_payload():
    pl.check_bindings(make(), **ok())


def test_bindings_reject_another_vault():
    """A payload for a retired or test vault must not price this one."""
    with pytest.raises(ValueError, match="targets app"):
        pl.check_bindings(make(target_app=999), **ok())


def test_bindings_reject_another_pool():
    """The $U pools differ 2.7x in price — crossing them is a huge misprice."""
    with pytest.raises(ValueError, match="prices pool"):
        pl.check_bindings(make(pool_id=3_673_941_603), **ok())


def test_bindings_reject_another_network():
    with pytest.raises(ValueError, match="different network"):
        pl.check_bindings(make(genesis=b"\x11" * 32), **ok())


def test_bindings_reject_a_stale_payload():
    """
    Replay protection, and it is not about our key: a signed payload is public
    the moment it is used, so anyone can keep one from a spike and resend it.
    """
    with pytest.raises(ValueError, match="old"):
        pl.check_bindings(make(issued_at=1_791_600_000), now=1_791_600_021,
                          target_app=VAULT, pool_id=POOL, max_age=20)


def test_bindings_accept_a_payload_exactly_at_the_age_limit():
    pl.check_bindings(make(issued_at=1_791_600_000), now=1_791_600_020,
                      target_app=VAULT, pool_id=POOL, max_age=20)


def test_bindings_reject_a_payload_from_the_future():
    with pytest.raises(ValueError, match="future"):
        pl.check_bindings(make(issued_at=1_791_600_100), **ok())


def test_bindings_tolerate_small_clock_skew():
    """Node clocks differ; a 2s skew must not reject an honest payload."""
    pl.check_bindings(make(issued_at=1_791_600_012), **ok())


# ── bundle ────────────────────────────────────────────────────────────────────

def test_bundle_indexes_by_the_signed_bytes_not_a_caller_claim():
    s1 = pl.sign(make(pool_id=POOL), SEED)
    s2 = pl.sign(make(pool_id=3_673_941_603, price=2_528_944), SEED)
    b = json.loads(pl.make_bundle([s1, s2]))
    assert set(b["payloads"]) == {
        f"app-{VAULT}/pool-{POOL}", f"app-{VAULT}/pool-3673941603"}
    entry = b["payloads"][f"app-{VAULT}/pool-{POOL}"]
    assert pl.verify(bytes.fromhex(entry["message_hex"]),
                     bytes.fromhex(entry["signature_hex"]), pub()).pool_id == POOL


def test_bundle_refuses_duplicate_pools():
    """Two payloads for one pool means a consumer's choice is undefined."""
    s = pl.sign(make(), SEED)
    with pytest.raises(ValueError, match="duplicate"):
        pl.make_bundle([s, s])


def test_bundle_envelope_extras_are_not_load_bearing():
    """
    The envelope carries price/pool_id for dashboards. Corrupting them must not
    change what a verifier concludes — it reads only the signed bytes.
    """
    b = json.loads(pl.make_bundle([pl.sign(make(), SEED)]))
    entry = b["payloads"][f"app-{VAULT}/pool-{POOL}"]
    entry["price"] = 1
    entry["pool_id"] = 42
    p = pl.verify(bytes.fromhex(entry["message_hex"]),
                  bytes.fromhex(entry["signature_hex"]), pub())
    assert p.price == 915_905 and p.pool_id == POOL
