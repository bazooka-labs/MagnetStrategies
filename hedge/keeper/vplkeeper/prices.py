"""Venue clients and the settled-number derivation.

Four exchanges, each read for the same clock-aligned 1-minute candle. Every component
of OHLC4 is published and permanent, so any participant can check a settlement against
a chart — that verifiability is the deterrent the product runs on, which is why this
is the part of the keeper that is public.

Not the candle *open*: an open is the first executed trade of the minute, so moving it
means owning one print rather than holding a level. OHLC4 requires moving the open, the
high, the low and the close — sustained pressure across the whole minute against
arbitrage — and is exactly as checkable.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

TIMEOUT = 10

# Source index is part of the signed preimage, so this order is fixed and must never
# be reshuffled — index 0 is Coinbase for the life of the deployment.
VENUES = ("coinbase", "kraken", "gemini", "bitstamp")
SOURCE_COUNT = 4
MIN_SOURCES = 3


@dataclass(frozen=True)
class Candle:
    """One venue's 1-minute candle. `ts` is the clock-aligned OPEN BOUNDARY in seconds
    — the bucket key, not a trade time. The contract asserts it equals the checkpoint
    exactly, so a venue returning milliseconds (Gemini does) must be normalised here."""

    ts: int
    open: int
    high: int
    low: int
    close: int

    def ohlc4(self) -> int:
        """(O + H + L + C) / 4, in the contract's 6-decimal fixed point."""
        return (self.open + self.high + self.low + self.close) // 4


def _to_micro(x: float | str) -> int:
    """USD -> 6dp fixed point, matching mUSD and the contract's price scale."""
    return int(round(float(x) * 1_000_000))


def _get(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": "vpl-keeper/0.1"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def fetch_coinbase(checkpoint: int) -> Candle:
    rows = _get(
        "https://api.exchange.coinbase.com/products/BTC-USD/candles"
        f"?granularity=60&start={checkpoint}&end={checkpoint + 60}"
    )
    for ts, low, high, opn, close, _vol in rows:
        if int(ts) == checkpoint:
            return Candle(int(ts), _to_micro(opn), _to_micro(high),
                          _to_micro(low), _to_micro(close))
    raise LookupError(f"coinbase: no candle at {checkpoint}")


def fetch_kraken(checkpoint: int) -> Candle:
    d = _get("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1"
             f"&since={checkpoint - 60}")
    key = next(k for k in d["result"] if k != "last")
    for ts, opn, high, low, close, _vwap, _vol, _cnt in d["result"][key]:
        if int(ts) == checkpoint:
            return Candle(int(ts), _to_micro(opn), _to_micro(high),
                          _to_micro(low), _to_micro(close))
    raise LookupError(f"kraken: no candle at {checkpoint}")


def fetch_gemini(checkpoint: int) -> Candle:
    rows = _get("https://api.gemini.com/v2/candles/btcusd/1m")
    for ms, opn, high, low, close, _vol in rows:
        if int(ms) // 1000 == checkpoint:      # Gemini reports milliseconds
            return Candle(checkpoint, _to_micro(opn), _to_micro(high),
                          _to_micro(low), _to_micro(close))
    raise LookupError(f"gemini: no candle at {checkpoint}")


def fetch_bitstamp(checkpoint: int) -> Candle:
    d = _get("https://www.bitstamp.net/api/v2/ohlc/btcusd/"
             f"?step=60&limit=5&start={checkpoint - 120}")
    for row in d["data"]["ohlc"]:
        if int(row["timestamp"]) == checkpoint:
            return Candle(checkpoint, _to_micro(row["open"]), _to_micro(row["high"]),
                          _to_micro(row["low"]), _to_micro(row["close"]))
    raise LookupError(f"bitstamp: no candle at {checkpoint}")


FETCHERS = {
    "coinbase": fetch_coinbase,
    "kraken": fetch_kraken,
    "gemini": fetch_gemini,
    "bitstamp": fetch_bitstamp,
}


def read_all(checkpoint: int) -> tuple[list[int], list[int], int]:
    """Read every venue for `checkpoint`, returning (prices, timestamps, present_mask)
    in the contract's slot order. A venue that fails or has no candle is left absent —
    zeroed in both arrays and cleared in the mask, which is exactly what the contract
    writes on-chain for an absent slot.

    Raises if fewer than MIN_SOURCES respond; the caller retries rather than signing a
    submission the contract would reject.
    """
    prices = [0] * SOURCE_COUNT
    timestamps = [0] * SOURCE_COUNT
    mask = 0
    for i, venue in enumerate(VENUES):
        try:
            c = FETCHERS[venue](checkpoint)
        except (urllib.error.URLError, LookupError, KeyError, ValueError, TimeoutError):
            continue
        if c.ts != checkpoint:
            continue
        prices[i] = c.ohlc4()
        timestamps[i] = c.ts
        mask |= 1 << i
    if bin(mask).count("1") < MIN_SOURCES:
        raise RuntimeError(f"quorum: only {bin(mask).count('1')} of 4 venues at {checkpoint}")
    return prices, timestamps, mask


def median(prices: list[int], mask: int) -> int:
    """The same aggregation the contract performs, for pre-flight checking.

    Four present -> mean of the middle two; three -> the middle one. Mirrors the
    contract's fixed sorting network, including its floor division.
    """
    present = sorted(p for i, p in enumerate(prices) if mask & (1 << i))
    if len(present) == 4:
        a, b = present[1], present[2]
        return a + (b - a) // 2
    if len(present) == 3:
        return present[1]
    raise ValueError("below quorum")
