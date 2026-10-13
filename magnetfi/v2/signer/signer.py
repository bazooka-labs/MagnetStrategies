"""
MagnetFi v5 signer — prices pools, signs payloads, publishes a bundle.

Spec: magnetfi/v2/ORACLE_V5_SPEC.md. Format: magnetfi/v2/SIGNED_PAYLOAD.md.

── What this is, relative to the bot it replaces ─────────────────────────────

The v3 oracle bot computed a price and POSTED it, holding a key the contract
trusted. This computes the same price, SIGNS it, and publishes it where anyone
can fetch it. Nobody has to trust the publisher, and nobody has to wait for it:
a liquidator who needs certainty carries a payload into their own transaction
group.

The pricing pipeline is NOT rebuilt here. It lives in oracle_bot.py with 139
tests — reference-pool graph, TWAP, multi-route cross-checks, CompX — and this
module imports it. What is new is the signing, the confidence policy and the
publishing.

── The one thing this must never become ─────────────────────────────────────

A gate. Under v5 there is no contract band, so if the signer refuses to sign,
no payload exists and NOBODY can post — the same total halt as a band that
rejects, just moved off chain. ORACLE_V5_SPEC.md §2.6.

So the price bounds are deliberately absent: `get_lp_price` is called with
`apply_anchor_bounds=False`. What is kept catches BUGS rather than key theft —
TWAP smoothing, the route cross-checks, and the wide scaling-slip band in
`payload.encode()`, which sits three orders of magnitude clear of any real
price and so can never rot.

The single exception is a cold TWAP, below. Signing an unsmoothed spot price on
a pool as thin as U/tALGO is the one genuinely catastrophic thing available
here, so that case refuses — and it is bounded: a cold start needs
MIN_TWAP_READINGS x POLL_INTERVAL = 15 minutes, which fits INSIDE the vault's
30-minute freshness window, so the last good on-chain price covers the gap and
a signer restart does not cause an outage.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "oracle_bot"))
import oracle_bot as ob            # noqa: E402  — the pricing pipeline, 139 tests
import payload as pl               # noqa: E402

log = logging.getLogger("signer")

# Where the signing key comes from. A RAW 32-byte ed25519 seed in hex — NOT an
# Algorand mnemonic, because this key is deliberately not an Algorand account:
# it posts nothing, holds nothing, and cannot sign a transaction. That closes
# the cross-protocol question by construction rather than by domain separation.
SEED_ENV = "SIGNER_SEED_HEX"

# Validity the signer REQUESTS. The contract clamps to its own ceiling, so this
# can only ever shorten a payload's life, never extend it.
FULL_MAX_AGE = pl.PAYLOAD_MAX_AGE
DEGRADED_MAX_AGE = 10

# Where the bundle is written. Publishing to object storage is a separate step
# and needs a bucket; until then this is the artefact a relay would upload.
BUNDLE_PATH = Path(os.environ.get("BUNDLE_PATH", Path(__file__).parent / "bundle.json"))


def load_signing_key() -> bytes:
    """Read and validate the seed. Raises rather than guessing."""
    raw = os.environ.get(SEED_ENV, "").strip()
    if not raw:
        raise RuntimeError(
            f"{SEED_ENV} is not set. It must be a 32-byte ed25519 seed in hex "
            f"(64 characters) — not an Algorand mnemonic."
        )
    try:
        seed = bytes.fromhex(raw)
    except ValueError as e:
        raise RuntimeError(f"{SEED_ENV} is not valid hex: {e}") from None
    if len(seed) != 32:
        raise RuntimeError(f"{SEED_ENV} decodes to {len(seed)} bytes, need 32")
    return seed


def public_key(seed: bytes) -> bytes:
    """The 32 bytes pinned in the oracle contract."""
    import nacl.signing
    return bytes(nacl.signing.SigningKey(seed).verify_key)


def requested_max_age(compx_verified: bool) -> int:
    """
    How long this payload should be worth.

    A clamp, never an extension — the contract applies min(its ceiling, this).
    So an honest signer can say "this one is worth less than usual" when its
    second opinion is missing, and a compromised one still cannot buy itself a
    longer window.
    """
    return FULL_MAX_AGE if compx_verified else DEGRADED_MAX_AGE


def sign_pool(client, cfg, pool, twap, oracle_app_id: int, seed: bytes,
              genesis: bytes = pl.GENESIS_MAINNET,
              now: int | None = None) -> tuple[bytes, bytes] | None:
    """
    Price one pool and return (message, signature), or None if it cannot be
    priced SAFELY. None means no payload for this pool this tick.

    Note what is NOT a reason to return None: a price far from the last one, or
    far from anything. There is no band here by design.
    """
    result = ob.get_lp_price(client, pool, cfg, apply_anchor_bounds=False)
    if result is None:
        log.warning(f"[{pool.label}] could not compute a price — not signing")
        return None
    spot, compx_verified = result

    # The clock is an argument, not a hidden global.
    #
    # `issued_at` is the only thing standing between a published payload and
    # unlimited replay, so the signer's clock is a correctness input and should
    # be visible as one. It also lets a caller stamp from a trusted source — a
    # test against a dev chain, or one day an NTP-disciplined reading rather
    # than whatever the host believes.
    now = int(time.time()) if now is None else now
    twap.add(pool.pool_id, now, spot, ob.TWAP_WINDOW)

    # The one refusal. An unsmoothed price on a thin pool is signable garbage:
    # anyone who can move the pool for a single block could make us sign it.
    if twap.count(pool.pool_id) < ob.MIN_TWAP_READINGS:
        log.info(f"[{pool.label}] only {twap.count(pool.pool_id)}/{ob.MIN_TWAP_READINGS} "
                 f"readings — not signing until the window fills "
                 f"(~{ob.MIN_TWAP_READINGS * ob.POLL_INTERVAL // 60} min; the last "
                 f"on-chain price stays valid for 30)")
        return None

    price = twap.twap(pool.pool_id, spot)
    max_age = requested_max_age(compx_verified)
    if max_age != FULL_MAX_AGE:
        log.warning(f"[{pool.label}] second source unavailable — signing with a "
                    f"{max_age}s life instead of {FULL_MAX_AGE}s")

    msg, sig = pl.sign(pl.Payload(
        target_app=oracle_app_id,
        lp_asa_id=pool.pool_id,
        # Equal until a band policy is decided (SIGNED_PAYLOAD.md). The capacity
        # is reserved so enabling one later needs no new format.
        price_min=price, price_max=price,
        issued_at=now, max_age=max_age, genesis=genesis,
    ), seed)
    log.info(f"[{pool.label}] signed {price} (spot {spot}, max_age {max_age}s)")
    return msg, sig


def run_once(client, cfg, twap, oracle_app_id: int, seed: bytes,
             genesis: bytes = pl.GENESIS_MAINNET, now: int | None = None) -> str:
    """Price and sign every configured pool; return the bundle JSON."""
    signed: list[tuple[bytes, bytes]] = []
    for pool in cfg.pools:
        try:
            out = sign_pool(client, cfg, pool, twap, oracle_app_id, seed, genesis, now)
        except Exception as e:  # noqa: BLE001 — one bad pool must not stop the rest
            log.exception(f"[{pool.label}] signing failed: {e}")
            continue
        if out:
            signed.append(out)
    if not signed:
        log.error("no pools could be signed this tick — the bundle would be empty")
    return pl.make_bundle(signed, generated_at=int(time.time()))


def publish(bundle: str, path: Path = BUNDLE_PATH) -> None:
    """
    Write the bundle where a relay or a CDN can take it.

    Atomic: written to a temp file and renamed, so a reader never sees a
    half-written bundle. That matters more here than usual — a truncated bundle
    is a bundle whose signatures do not verify, which looks exactly like an
    attack.

    Uploading to object storage is deliberately NOT done here. It needs a
    bucket, and it needs PEX's cache headers (`no-cache, must-revalidate`) or a
    CDN TTL silently eats the 30-second window.
    """
    tmp = path.with_suffix(".tmp")
    tmp.write_text(bundle)
    tmp.replace(path)
    log.info(f"bundle written to {path} ({len(bundle)} bytes)")


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description="MagnetFi v5 signer")
    ap.add_argument("--config", default=str(Path(__file__).resolve().parents[1]
                                            / "oracle_bot" / "config.json"))
    ap.add_argument("--oracle-app-id", type=int, required=True,
                    help="the RelayOracle app id payloads are bound to")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--print-pubkey", action="store_true",
                    help="print the public key to pin in the contract, then exit")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(message)s",
                        datefmt="%Y-%m-%dT%H:%M:%SZ")
    logging.Formatter.converter = time.gmtime

    seed = load_signing_key()
    if args.print_pubkey:
        print(public_key(seed).hex())
        return

    cfg = ob.load_config(Path(args.config))
    client = ob.make_algod_client()
    twap = ob.TwapState(ob.STATE_FILE)

    log.info(f"Signer public key: {public_key(seed).hex()}")
    log.info(f"Target oracle app: {args.oracle_app_id}")
    log.info(f"Pools:             {[p.label for p in cfg.pools]}")
    log.info(f"Bundle path:       {BUNDLE_PATH}")

    while True:
        publish(run_once(client, cfg, twap, args.oracle_app_id, seed))
        if args.once:
            return
        time.sleep(ob.POLL_INTERVAL)


if __name__ == "__main__":
    main()
