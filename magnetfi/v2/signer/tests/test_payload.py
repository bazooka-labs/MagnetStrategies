"""
Tests for the v4 signed-payload wire format.

The vault's verifier must agree with payload.py byte for byte, so these pin the
format itself — magic, length, offsets, endianness — not just round-tripping. A
round-trip test alone would pass on a format both sides got wrong together.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import payload as pl                                             # noqa: E402

SEED = bytes(range(32))          # deterministic, so the vector below is stable
VAULT = 3_671_287_267
LP = 3_163_770_927               # U/tALGO LP token ASA
PRICE = 915_905


def make(**over) -> pl.Payload:
    d = dict(target_app=VAULT, lp_asa_id=LP, price_min=PRICE, price_max=PRICE,
             issued_at=1_791_600_000)
    d.update(over)
    return pl.Payload(**d)


def pub() -> bytes:
    import nacl.signing
    return bytes(nacl.signing.SigningKey(SEED).verify_key)


def ok(**over):
    d = dict(target_app=VAULT, lp_asa_id=LP, now=1_791_600_010)
    d.update(over)
    return d


# ── the format itself ─────────────────────────────────────────────────────────

def test_message_is_exactly_85_bytes():
    assert len(pl.encode(make())) == pl.MSG_LEN == 85


def test_field_offsets_are_what_the_contract_will_read():
    """
    Pinned by OFFSET, hand-written, not by round-trip. The vault reads these
    positions with extract_uint64, so a field moving is a silent misprice and a
    round-trip test would not notice.
    """
    m = pl.encode(make())
    assert m[0:4] == b"MFLP"
    assert m[4] == 1
    assert m[5:37] == pl.GENESIS_MAINNET
    assert int.from_bytes(m[37:45], "big") == VAULT
    assert int.from_bytes(m[45:53], "big") == LP
    assert int.from_bytes(m[53:61], "big") == PRICE          # price_min
    assert int.from_bytes(m[61:69], "big") == PRICE          # price_max
    assert int.from_bytes(m[69:77], "big") == 1_791_600_000  # issued_at
    assert int.from_bytes(m[77:85], "big") == 30             # max_age


def test_the_three_constants_are_contiguous_at_the_front():
    """
    magic+version+genesis occupy 0..36 so a verifier checks all three with one
    `extract 0 37` and one `==`. Measured: the whole bindings block is 49
    opcode units against 1900 for the signature.
    """
    m = pl.encode(make())
    assert m[0:37] == pl.MAGIC + bytes([pl.VERSION]) + pl.GENESIS_MAINNET


def test_every_numeric_field_is_eight_bytes():
    """So extract_uint64 applies uniformly — no partial-word extraction."""
    assert (pl.MSG_LEN - 37) % 8 == 0


def test_integers_are_big_endian():
    """
    Little-endian would read 915,905 as 1.3e16 — a valid-looking disaster.

    Uses 1000 rather than 1 because the sanity band now refuses 1 as a scaling
    error, which is itself the point: this test originally used 1 and the band
    caught it.
    """
    assert pl.encode(make(price_min=1000, price_max=1000))[53:61] == (
        b"\x00\x00\x00\x00\x00\x00\x03\xe8")


def test_known_vector_is_stable():
    """
    A frozen regression vector, generated once from the encoder and pinned.

    It deliberately does NOT carry its own semantics — asserting the encoder
    matches bytes the encoder produced would be circular. What it catches is the
    format CHANGING: once a verifier is deployed, any change to these bytes
    breaks it, so the change must be deliberate with a version bump rather than
    the side effect of an edit.

    The semantic check is test_field_offsets_are_what_the_contract_will_read,
    whose slice positions and expected integers are written by hand. (A hand-
    computed vector here was wrong in two fields on the first attempt, which is
    exactly why the offset test is the one that carries the meaning.)
    """
    assert pl.encode(make()).hex() == (
        "4d464c50"                                                           # magic
        "01"                                                                 # version
        "c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf"   # genesis
        "00000000dad365e3"                                                   # target_app
        "00000000bc93502f"                                                   # lp_asa_id
        "00000000000df9c1"                                                   # price_min
        "00000000000df9c1"                                                   # price_max
        "000000006ac9a580"                                                   # issued_at
        "000000000000001e"                                                   # max_age = 30
    )


def test_roundtrip():
    p = make()
    assert pl.decode(pl.encode(p)) == p


def test_price_musd_is_the_scaled_mid():
    assert make(price_min=900_000, price_max=1_100_000).price_musd == pytest.approx(1.0)


# ── the window constants, which the contract will freeze ──────────────────────

def test_window_constants_follow_pex():
    """
    PEX's live bundle runs max_age_seconds 30 and max_future_skew_seconds 0.
    An earlier draft claimed PEX used 20s — wrong by 33%, and it was this
    design's only cited precedent.
    """
    assert pl.PAYLOAD_MAX_AGE == 30
    assert pl.CLOCK_SKEW == 0


# ── encode refuses what it cannot represent ───────────────────────────────────

def test_encode_refuses_zero_price():
    """A zero permanently bricks a pool (AUD-042). Never sign one."""
    with pytest.raises(ValueError, match="price_min must be > 0"):
        pl.encode(make(price_min=0, price_max=0))


def test_encode_refuses_an_inverted_band():
    with pytest.raises(ValueError, match="price_max .* < price_min"):
        pl.encode(make(price_min=PRICE, price_max=PRICE - 1))


def test_encode_refuses_values_too_big_for_u64():
    """A wrapped value is a wrong price carrying a VALID signature."""
    with pytest.raises(ValueError, match="u64"):
        pl.encode(make(price_min=1 << 64, price_max=1 << 64))
    with pytest.raises(ValueError, match="u64"):
        pl.encode(make(lp_asa_id=1 << 64))


def test_encode_refuses_a_bool_masquerading_as_an_int():
    """bool is an int in Python; True would silently encode as price 1."""
    with pytest.raises(TypeError):
        pl.encode(make(price_min=True, price_max=True))


@pytest.mark.parametrize("bad", [1, 999, 1_000_000_001, 915_905_000_000])
def test_encode_catches_a_scaling_slip(bad):
    """
    v4 removes the per-pool bounds, leaving this as the only guard against a
    magnitude error. 915905 x 1e6 = 9.15e11 is the x1e6 slip; 1 and 999 are the
    other direction.
    """
    with pytest.raises(ValueError, match="sanity band"):
        pl.encode(make(price_min=bad, price_max=bad))


def test_the_sanity_band_admits_every_live_price():
    """U/ALGO 862635, U/tALGO 915905, ALGO/USDC 1143181, U/USDC 2528944."""
    for v in (862_635, 915_905, 1_143_181, 2_528_944):
        pl.encode(make(price_min=v, price_max=v))


def test_encode_refuses_a_max_age_above_the_ceiling():
    """The signer may ask for a SHORTER life, never a longer one."""
    with pytest.raises(ValueError, match="exceeds the ceiling"):
        pl.encode(make(max_age=pl.PAYLOAD_MAX_AGE + 1))


def test_encode_refuses_a_zero_max_age():
    with pytest.raises(ValueError, match="born expired"):
        pl.encode(make(max_age=0))


def test_encode_refuses_a_wrong_length_genesis():
    with pytest.raises(ValueError, match="32 bytes"):
        pl.encode(make(genesis=b"\x00" * 31))


def test_encode_refuses_an_unknown_version():
    with pytest.raises(ValueError, match="version"):
        pl.encode(make(version=2))


# ── decode rejects anything it cannot fully account for ───────────────────────

@pytest.mark.parametrize("n", [0, 1, 69, 84, 86, 133])
def test_decode_refuses_wrong_lengths(n):
    with pytest.raises(ValueError, match="bytes"):
        pl.decode(b"\x00" * n)


def test_decode_refuses_foreign_magic():
    """A PEX payload is 133 bytes of PDX2 — it must never read as a price here."""
    m = bytearray(pl.encode(make())); m[0:4] = b"PDX2"
    with pytest.raises(ValueError, match="magic"):
        pl.decode(bytes(m))


def test_decode_refuses_a_future_version_rather_than_half_reading_it():
    """
    `!=` not `>=`: that is what makes a prefix-extended v2 unreadable by a v1
    verifier instead of silently half-read.
    """
    m = bytearray(pl.encode(make())); m[4] = 2
    with pytest.raises(ValueError, match="version"):
        pl.decode(bytes(m))


# ── signature ─────────────────────────────────────────────────────────────────

def test_sign_then_verify_then_bind_roundtrips():
    msg, sig = pl.sign(make(), SEED)
    assert pl.check_bindings(pl.verify(msg, sig, pub()), **ok()) == make()


def test_verify_alone_exposes_no_price():
    """
    The misuse hazard, closed structurally. `verify(...).price_min` used to be
    the shortest thing to write, and it consumed a payload that might be for
    another network, another vault, another pool, and arbitrarily stale.
    """
    msg, sig = pl.sign(make(), SEED)
    u = pl.verify(msg, sig, pub())
    assert isinstance(u, pl.UnboundPayload)
    for attr in ("price_min", "price_max", "price_musd", "lp_asa_id", "target_app"):
        assert not hasattr(u, attr), f"UnboundPayload exposes {attr}"
    assert u.issued_at == 1_791_600_000       # age is legitimately readable


@pytest.mark.parametrize("i", [0, 4, 40, 44, 53, 61, 70, 84])
def test_verify_rejects_a_tampered_message(i):
    from nacl.exceptions import BadSignatureError
    msg, sig = pl.sign(make(), SEED)
    bad = bytearray(msg); bad[i] ^= 0x01
    with pytest.raises(BadSignatureError):
        pl.verify(bytes(bad), sig, pub())


def test_verify_rejects_a_tampered_signature():
    from nacl.exceptions import BadSignatureError
    msg, sig = pl.sign(make(), SEED)
    bad = bytearray(sig); bad[0] ^= 0x01
    with pytest.raises(BadSignatureError):
        pl.verify(msg, bytes(bad), pub())


def test_verify_rejects_another_signers_key():
    """The pinned key is the point: a valid signature is not enough."""
    import nacl.signing
    from nacl.exceptions import BadSignatureError
    other = bytes(nacl.signing.SigningKey(bytes(range(1, 33))).verify_key)
    msg, sig = pl.sign(make(), SEED)
    with pytest.raises(BadSignatureError):
        pl.verify(msg, sig, other)


def test_verify_rejects_a_malleated_signature():
    """
    S+L is the classic ed25519 malleability variant. pynacl and the mainnet AVM
    were measured to agree exactly on rejecting it — cross-implementation
    agreement between signer and verifier is the property that matters.
    """
    from nacl.exceptions import BadSignatureError
    L = 2**252 + 27742317777372353535851937790883648493
    msg, sig = pl.sign(make(), SEED)
    S = int.from_bytes(sig[32:], "little")
    mal = sig[:32] + ((S + L) % (1 << 256)).to_bytes(32, "little")
    with pytest.raises(BadSignatureError):
        pl.verify(msg, mal, pub())


def test_sign_refuses_a_wrong_length_seed():
    with pytest.raises(ValueError, match="32 bytes"):
        pl.sign(make(), b"short")


def test_sign_returns_the_bytes_it_signed():
    """So a caller cannot sign one message and publish a different one."""
    msg, sig = pl.sign(make(), SEED)
    assert msg == pl.encode(make()) and len(sig) == 64


# ── bindings: authentic, but for something else ───────────────────────────────

def bound(p=None, **over):
    msg, sig = pl.sign(p or make(), SEED)
    return pl.check_bindings(pl.verify(msg, sig, pub()), **ok(**over))


def test_bindings_accept_a_matching_payload():
    assert bound().lp_asa_id == LP


def test_bindings_reject_another_vault():
    """A payload for a retired or test vault must not price this one."""
    with pytest.raises(ValueError, match="targets app"):
        bound(make(target_app=999))


def test_bindings_reject_another_pools_lp_token():
    """U/tALGO and U/USDC prices differ 2.7x — crossing them is a huge misprice."""
    with pytest.raises(ValueError, match="prices LP ASA"):
        bound(make(lp_asa_id=3_673_941_603, price_min=2_528_944, price_max=2_528_944))


def test_bindings_reject_another_network():
    with pytest.raises(ValueError, match="different network"):
        bound(make(genesis=b"\x11" * 32))


def test_bindings_reject_a_stale_payload():
    """
    Replay protection, and it is not about our key: a signed payload is public
    the moment it is used, so anyone can keep one from a spike and resend it.
    """
    with pytest.raises(ValueError, match="old"):
        bound(now=1_791_600_031)


def test_bindings_accept_a_payload_exactly_at_the_age_limit():
    assert bound(now=1_791_600_030).issued_at == 1_791_600_000


def test_bindings_reject_a_payload_from_the_future():
    """CLOCK_SKEW is 0 — the chain clock already runs ~4s behind."""
    with pytest.raises(ValueError, match="future"):
        bound(make(issued_at=1_791_600_011))


def test_a_signer_requested_short_window_is_honoured():
    """A cold TWAP or a missing cross-check should make a payload worth less."""
    with pytest.raises(ValueError, match="limit 5s"):
        bound(make(max_age=5), now=1_791_600_006)
    assert bound(make(max_age=5), now=1_791_600_004) is not None


def test_a_caller_cannot_be_talked_into_a_longer_window_than_the_ceiling():
    """
    min() is the clamp. Even a consumer passing max_age=3600 gets the payload's
    own 30 — so a compromised signer cannot extend its payloads' lives, and a
    sloppy monitor cannot accept what the vault would reject.
    """
    with pytest.raises(ValueError, match="limit 30s"):
        bound(now=1_791_600_031, max_age=3600)


# ── bundle ────────────────────────────────────────────────────────────────────

def test_bundle_indexes_by_the_signed_bytes_not_a_caller_claim():
    s1 = pl.sign(make(), SEED)
    s2 = pl.sign(make(lp_asa_id=3_673_941_603, price_min=2_528_944,
                      price_max=2_528_944), SEED)
    b = json.loads(pl.make_bundle([s1, s2]))
    assert set(b["payloads"]) == {f"app-{VAULT}/lp-{LP}",
                                  f"app-{VAULT}/lp-3673941603"}


def test_bundle_refuses_duplicate_pools():
    """Two payloads for one pool make a consumer's choice undefined."""
    s = pl.sign(make(), SEED)
    with pytest.raises(ValueError, match="duplicate"):
        pl.make_bundle([s, s])


def test_bundle_envelope_extras_are_not_load_bearing():
    """
    The envelope carries prices for dashboards. Corrupting them must not change
    what a verifier concludes — it reads only the signed bytes.
    """
    b = json.loads(pl.make_bundle([pl.sign(make(), SEED)]))
    e = b["payloads"][f"app-{VAULT}/lp-{LP}"]
    e["price_min"] = 1; e["lp_asa_id"] = 42; e["max_age"] = 99999
    p = pl.check_bindings(
        pl.verify(bytes.fromhex(e["message_hex"]), bytes.fromhex(e["signature_hex"]), pub()),
        **ok())
    assert (p.price_min, p.lp_asa_id, p.max_age) == (PRICE, LP, 30)


def test_bundle_carries_no_public_key():
    """
    PEX's own bundle ships pubkey_hex, which is exactly the trap
    read_pex_algo_price exists to avoid. Ours must never offer the temptation.
    """
    raw = pl.make_bundle([pl.sign(make(), SEED)])
    assert "pubkey" not in raw.lower()


def test_bundle_can_carry_a_freshness_marker():
    """So a monitor can tell "bundle is stale" from "this pool is missing"."""
    b = json.loads(pl.make_bundle([pl.sign(make(), SEED)], generated_at=1_791_600_000))
    assert b["generated_at"] == 1_791_600_000
    assert "generated_at" not in json.loads(pl.make_bundle([pl.sign(make(), SEED)]))
