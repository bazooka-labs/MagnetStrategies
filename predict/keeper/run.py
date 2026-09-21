#!/usr/bin/env python3
"""VPL round operations.

    python run.py status
    python run.py create            # next round: locks 09:00 ET, resolves 16:00 ET
    python run.py lock              # read venues -> sign -> publish -> submit
    python run.py resolve
    python run.py settle            # pay winners, close losers

Each command is idempotent in the sense that matters: attestations are signed once per
(round, checkpoint) and persisted, so a retry resubmits the SAME bytes. Re-signing with
a different mask would leave two valid attestations public, and lock/resolve are
permissionless — a participant would pick whichever median landed in their band.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import algokit_utils
from algokit_utils import AppClientMethodCallParams as Call

from vplkeeper import chain, config
from vplkeeper.attest import CHECKPOINT_LOCK, CHECKPOINT_RESOLVE, AttestationStore
from vplkeeper.config import PRICE_FEED_ID
from vplkeeper.prices import median, read_all

ET = ZoneInfo("America/New_York")
LOCK_HOUR, RESOLVE_HOUR = 9, 16
STATUS = {0: "OPEN", 1: "LOCKED", 2: "RESOLVED", 3: "VOID"}
VOID_REASON = {0: "thin", 1: "empty_band", 2: "no_lock", 3: "no_resolve", 4: "admin"}


class FileStore(AttestationStore):
    """Durable sign-once. The in-memory base class would lose its record on the exact
    failure this guards against — a crash between signing and submitting."""

    def __init__(self, path: Path) -> None:
        super().__init__()
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            for row in json.loads(self.path.read_text()):
                from vplkeeper.attest import Attestation
                att = Attestation(row["round_id"], row["kind"], row["mask"],
                                  row["prices"], row["timestamps"],
                                  bytes.fromhex(row["sig"]))
                self._by_key[att.key] = att

    def get_or_sign(self, *a, **kw):
        before = len(self._by_key)
        att = super().get_or_sign(*a, **kw)
        if len(self._by_key) != before:
            self.path.write_text(json.dumps([
                {"round_id": x.round_id, "kind": x.checkpoint_kind,
                 "mask": x.present_mask, "prices": x.prices,
                 "timestamps": x.timestamps, "sig": x.signature.hex()}
                for x in self._by_key.values()], indent=1))
            self.path.chmod(0o600)
        return att


def _next_checkpoints() -> tuple[int, int, int]:
    """open_time now, lock at the next 09:00 ET, resolve the same day at 16:00 ET.

    Both checkpoints must be minute-aligned — the contract asserts it, because an
    attestation's candle boundary is compared for equality against them.
    """
    now = datetime.now(ET)
    lock = now.replace(hour=LOCK_HOUR, minute=0, second=0, microsecond=0)
    if lock <= now:
        lock += timedelta(days=1)
    resolve = lock.replace(hour=RESOLVE_HOUR)
    # open_time must be >= the chain's clock, not ours. A small forward buffer absorbs
    # the gap between building the transaction and a block accepting it; rounding DOWN
    # to the minute would put it seconds in the past and the contract would reject it.
    open_t = int(now.timestamp()) + 120
    return open_t, int(lock.timestamp()), int(resolve.timestamp())


def _open_round(app) -> tuple[int, dict] | tuple[None, None]:
    rid = int(app.get_global_state()["rcount"].value)
    if not rid:
        return None, None
    return rid, app.send.call(Call(method="get_round", args=[rid])).abi_return


def cmd_status(cfg, client, app) -> int:
    gs = app.get_global_state()
    bal, oblig, rake = app.send.call(Call(method="get_solvency", args=[])).abi_return
    print(f"app {cfg.app_id}   rounds {int(gs['rcount'].value)}   "
          f"open_round {int(gs['open_rid'].value)}   paused {int(gs['paused'].value)}")
    print(f"mUSD balance {bal / 1e6:,.2f}   obligations {oblig / 1e6:,.2f}   "
          f"rake owed {rake / 1e6:,.2f}   solvent {bal >= oblig + rake}")
    rid, rnd = _open_round(app)
    if not rid:
        print("no rounds yet")
        return 0
    st = STATUS.get(rnd["status"], rnd["status"])
    extra = f" ({VOID_REASON.get(rnd['void_reason'])})" if rnd["status"] == 3 else ""
    print(f"\nround {rid}  {st}{extra}")
    print(f"  lock    {datetime.fromtimestamp(rnd['lock_time'], ET):%Y-%m-%d %H:%M %Z}")
    print(f"  resolve {datetime.fromtimestamp(rnd['resolve_time'], ET):%Y-%m-%d %H:%M %Z}")
    print(f"  stake   {rnd['total_stake'] / 1e6:,.2f} mUSD across "
          f"{sum(1 for s in rnd['band_stake'] if s)} band(s), "
          f"{rnd['position_count']} position(s)")
    if rnd["reference_price"]:
        print(f"  ref     {rnd['reference_price'] / 1e6:,.2f}")
    if rnd["settlement_price"]:
        print(f"  settle  {rnd['settlement_price'] / 1e6:,.2f}  "
              f"winning band {rnd['winning_band']}")
    if rnd["status"] == 0:
        ladder = app.send.call(Call(method="get_ladder", args=[rid])).abi_return
        print("  ladder  " + "  ".join(
            f"[{i}] {m / 10_000:.2f}x" if m else f"[{i}] —" for i, m in enumerate(ladder)))
    return 0


def cmd_create(cfg, client, app) -> int:
    open_t, lock_t, resolve_t = _next_checkpoints()
    print(f"open    {datetime.fromtimestamp(open_t, ET):%Y-%m-%d %H:%M %Z}")
    print(f"lock    {datetime.fromtimestamp(lock_t, ET):%Y-%m-%d %H:%M %Z}")
    print(f"resolve {datetime.fromtimestamp(resolve_t, ET):%Y-%m-%d %H:%M %Z}")
    app.send.call(Call(method="create_round", args=[open_t, lock_t, resolve_t]))
    rid = int(app.get_global_state()["rcount"].value)
    print(f"created round {rid}")
    return 0


def _checkpoint(cfg, client, app, kind: int, store: FileStore) -> int:
    rid, rnd = _open_round(app)
    if not rid:
        print("no round")
        return 1
    checkpoint = rnd["lock_time"] if kind == CHECKPOINT_LOCK else rnd["resolve_time"]
    name = "lock" if kind == CHECKPOINT_LOCK else "resolve"

    prices, timestamps, mask = read_all(checkpoint)
    n = bin(mask).count("1")
    print(f"{name} round {rid} @ {datetime.fromtimestamp(checkpoint, ET):%H:%M %Z}  "
          f"{n}/4 venues  median {median(prices, mask) / 1e6:,.2f}")

    oracle = config.load_oracle_key(cfg.oracle_key_path)
    att = store.get_or_sign(
        oracle, app_id=cfg.app_id, round_id=rid, checkpoint_kind=kind,
        price_feed_id=PRICE_FEED_ID, prices=prices, timestamps=timestamps,
        present_mask=mask)

    # PUBLISH before submitting. If submission fails, anyone can relay these bytes —
    # which is what stops a keeper crash between signing and sending from costing a
    # round, and what makes withholding a submission worthless.
    pub = cfg.oracle_key_path.parent / f"attestation-{rid}-{kind}.json"
    pub.write_text(json.dumps({
        "app_id": cfg.app_id, "round_id": rid, "checkpoint_kind": kind,
        "present_mask": att.present_mask, "prices": att.prices,
        "timestamps": att.timestamps, "signature": att.signature.hex()}, indent=1))
    print(f"  published {pub}")

    app.send.call(Call(
        method=name,
        args=[rid, att.present_mask, att.prices, att.timestamps, att.signature],
        extra_fee=chain.algo(5_000)))       # opup for ed25519verify_bare
    rnd = app.send.call(Call(method="get_round", args=[rid])).abi_return
    st = STATUS.get(rnd["status"])
    print(f"  -> {st}" + (f" ({VOID_REASON.get(rnd['void_reason'])})"
                          if rnd["status"] == 3 else ""))
    return 0


def cmd_settle(cfg, client, app, owners: list[str], bands: list[int]) -> int:
    """Manual for now: pass the positions to close.

    Automating discovery means reading the Entered events from the indexer, which is
    the next step once more than a handful of positions exist.
    """
    rid, rnd = _open_round(app)
    if rnd["status"] not in (2, 3):
        print(f"round {rid} is {STATUS.get(rnd['status'])}; nothing to settle")
        return 1
    winning = rnd["winning_band"]
    for owner, band in zip(owners, bands, strict=True):
        if rnd["status"] == 3:
            method = "refund_position"
            args = [rid, owner, band, owner]
        elif band == winning:
            method, args = "settle_position", [rid, owner, band, owner]
        else:
            method, args = "close_position", [rid, owner, band, owner]
        app.send.call(Call(method=method, args=args,
                           account_references=[owner],
                           asset_references=[cfg.musd_asset_id],
                           extra_fee=chain.algo(4_000)))
        print(f"  {method} {owner[:8]}… band {band}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["status", "create", "lock", "resolve", "settle"])
    ap.add_argument("--owner", action="append", default=[])
    ap.add_argument("--band", action="append", type=int, default=[])
    args = ap.parse_args()

    cfg = config.load()
    client = chain.algorand(cfg)
    signer = chain.account(
        client, "VPL_ADMIN_MNEMONIC" if args.command == "create"
        else "VPL_KEEPER_MNEMONIC")
    app = chain.app_client(cfg, client, signer)
    store = FileStore(cfg.oracle_key_path.parent / "attestations.json")

    if args.command == "status":
        return cmd_status(cfg, client, app)
    if args.command == "create":
        return cmd_create(cfg, client, app)
    if args.command == "lock":
        return _checkpoint(cfg, client, app, CHECKPOINT_LOCK, store)
    if args.command == "resolve":
        return _checkpoint(cfg, client, app, CHECKPOINT_RESOLVE, store)
    return cmd_settle(cfg, client, app, args.owner, args.band)


if __name__ == "__main__":
    sys.exit(main())
