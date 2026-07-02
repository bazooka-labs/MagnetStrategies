"""
MagnetFi v2 LP Oracle Bot

Posts TWAP-smoothed LP token prices to the on-chain LP Oracle contract every 5 minutes.

Price pipeline per pool (fully on-chain — no external HTTP price API):
  1. Read the LP pool's reserves + issued LP supply from the pool ACCOUNT's local
     state under the shared Tinyman v2 AMM validator app (NOT a per-pool app)
  2. Verify the pool's on-chain asset ids match config (guards a wrong pool_address)
  3. Derive each underlying's USD price ON-CHAIN via a reference-pool graph rooted at
     USDC (e.g. ALGO←ALGO/USDC, tALGO←tALGO/ALGO, U←U/tALGO) — see reference_pools
  4. Compute pool TVL and price per LP token (scaled × 1_000_000)
  5. Apply an absolute price sanity bound (min_price/max_price)
  6. Cross-check the volatile underlying against CompX's on-chain Flux oracle
     (second source / divergence guard, P19-02); refuse to post on disagreement
  7. Apply 5-reading trapezoidal TWAP (≈25-minute window)
  8. Run asymmetric divergence check (block upward spikes; let drops through)
  9. Post to oracle contract if all checks pass

Usage:
  python oracle_bot.py [--dry-run] [--once] [--config config.json]

Environment variables:
  BOT_MNEMONIC   — oracle bot wallet mnemonic (25 words) — required unless --dry-run
  ALGOD_URL      — algod node URL (default: https://mainnet-api.algonode.cloud)
  ALGOD_TOKEN    — algod API token (default: empty for public nodes)
  ORACLE_APP_ID  — LP Oracle contract app ID (can also be in config.json)
"""

import argparse
import base64
import json
import logging
import os
import sys
import time
from pathlib import Path

import algosdk
from algosdk import account, mnemonic
from algosdk.v2client import algod
from algosdk.abi import Method
from algosdk.atomic_transaction_composer import (
    AtomicTransactionComposer,
    AccountTransactionSigner,
)


# ── configuration ─────────────────────────────────────────────────────────────

DEFAULT_CONFIG_PATH = Path(__file__).parent / "config.json"
STATE_FILE = Path(__file__).parent / "twap_state.json"

# Tinyman v2 AMM validator app — ONE shared app for all pools on mainnet.
# Each pool is a separate ACCOUNT opted into this app; the pool's reserves and
# issued-LP supply live in that account's LOCAL state under this app id.
TINYMAN_V2_VALIDATOR_APP_ID = 1002541853

TWAP_WINDOW       = 5       # number of readings for TWAP
MIN_TWAP_READINGS = 3       # fail-stale: don't post until the window has this many readings
POLL_INTERVAL     = 300     # seconds between updates (5 minutes)
DIVERGENCE_LIMIT  = 0.15    # 15% max spot-vs-TWAP spread before skip
LP_DECIMALS       = 6       # Tinyman LP tokens have 6 decimal places
PRICE_SCALE       = 1_000_000   # on-chain price representation: 1.00 = 1_000_000
MAX_TWAP_AGE        = 1_800 # discard TWAP readings older than this (s) — never average across a downtime gap (F7)
UNVERIFIED_MAX_DROP = 0.10  # when CompX can't verify, only post flat / declines up to this fraction (F1/F5)

# Algod timeout / retry settings
ALGOD_TIMEOUT = 10
MAX_RETRIES   = 3
RETRY_DELAY   = 5

# ABI method signature for update_lp_price
UPDATE_LP_PRICE_SIG = "update_lp_price(uint64,uint64)void"


# ── logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("oracle_bot")


# ── TWAP state ────────────────────────────────────────────────────────────────

class TwapState:
    """Persistent TWAP history per pool_id. Survives bot restarts via JSON file."""

    def __init__(self, path: Path):
        self.path = path
        self.history: dict[int, list[tuple[int, int]]] = {}  # pool_id → [(ts, price)]
        self._load()

    def _load(self) -> None:
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text())
                self.history = {int(k): [(int(ts), int(p)) for ts, p in v]
                                for k, v in raw.items()}
            except Exception as e:
                log.warning(f"Failed to load TWAP state ({e}); starting fresh")

    def _save(self) -> None:
        tmp_path = self.path.with_suffix(".tmp")
        try:
            tmp_path.write_text(json.dumps(self.history))
            tmp_path.replace(self.path)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

    def add(self, pool_id: int, ts: int, price: int, window: int) -> None:
        history = self.history.setdefault(pool_id, [])
        history.append((ts, price))
        # Drop readings older than MAX_TWAP_AGE so we never time-weight across a
        # downtime gap (F7); with MIN_TWAP_READINGS this fails stale instead.
        cutoff = ts - MAX_TWAP_AGE
        history = [(t, p) for (t, p) in history if t >= cutoff]
        if len(history) > window:
            history = history[-window:]
        self.history[pool_id] = history
        self._save()

    def count(self, pool_id: int) -> int:
        """Number of readings currently held for pool_id."""
        return len(self.history.get(pool_id, []))

    def twap(self, pool_id: int, spot_price: int) -> int:
        """Return TWAP if enough history exists, otherwise return spot_price."""
        history = self.history.get(pool_id, [])
        if len(history) < 2:
            return spot_price
        total_time = history[-1][0] - history[0][0]
        if total_time == 0:
            return spot_price
        # Trapezoidal TWAP: each interval weighted by average of its start and end price.
        # This ensures the latest reading is always reflected in the output.
        weighted = sum(
            (history[i + 1][0] - history[i][0]) * (history[i][1] + history[i + 1][1]) / 2
            for i in range(len(history) - 1)
        )
        return int(weighted / total_time)


# ── configuration objects ──────────────────────────────────────────────────────

class PoolConfig:
    """Per-pool parameters for an LP token we price and post."""
    __slots__ = (
        "pool_id", "pool_address",
        "asset_a_id", "asset_a_decimals", "asset_b_id", "asset_b_decimals",
        "min_price", "max_price", "compx_check_asset_id", "label",
    )

    def __init__(self, d: dict) -> None:
        self.pool_id = int(d["pool_id"])
        self.pool_address = str(d["pool_address"])
        self.asset_a_id = int(d["asset_a_id"])
        self.asset_a_decimals = int(d["asset_a_decimals"])
        self.asset_b_id = int(d["asset_b_id"])
        self.asset_b_decimals = int(d["asset_b_decimals"])
        self.min_price = int(d.get("min_price", 0))
        self.max_price = int(d.get("max_price", 0))
        # Asset id to cross-check against the CompX oracle (the volatile underlying);
        # 0/absent disables the cross-check for this pool.
        self.compx_check_asset_id = int(d.get("compx_check_asset_id", 0))
        self.label = d.get("label", f"pool_{self.pool_id}")


class BotConfig:
    """Top-level bot configuration loaded from config.json."""
    __slots__ = (
        "oracle_app_id", "amm_app_id", "usdc_asa_id", "asset_decimals",
        "reference_pools", "asset_price_bounds", "compx_oracle_app_id",
        "compx_divergence_limit", "compx_max_age", "pools",
    )

    def __init__(self, raw: dict) -> None:
        self.oracle_app_id = int(raw.get("oracle_app_id", os.environ.get("ORACLE_APP_ID", 0)))
        self.amm_app_id = int(raw.get("amm_validator_app_id", TINYMAN_V2_VALIDATOR_APP_ID))
        self.usdc_asa_id = int(raw.get("usdc_asa_id", 31566704))
        # asset_id → decimals
        self.asset_decimals = {int(k): int(v) for k, v in raw.get("asset_decimals", {}).items()}
        # asset_id → (min_usdc, max_usdc) plausibility bounds for DERIVED prices (F3)
        self.asset_price_bounds = {
            int(k): (float(v[0]), float(v[1])) for k, v in raw.get("asset_price_bounds", {}).items()
        }
        # asset_id → {"pool_address": str, "quote_asset_id": int}
        self.reference_pools = {
            int(k): {"pool_address": str(v["pool_address"]),
                     "quote_asset_id": int(v["quote_asset_id"])}
            for k, v in raw.get("reference_pools", {}).items()
        }
        self.compx_oracle_app_id = int(raw.get("compx_oracle_app_id", 0))
        self.compx_divergence_limit = float(raw.get("compx_divergence_limit", 0.05))
        self.compx_max_age = int(raw.get("compx_max_age_seconds", 3600))
        self.pools = [PoolConfig(p) for p in raw.get("pools", [])]


def load_config(path: Path) -> BotConfig:
    if not path.exists():
        log.error(f"Config file not found: {path}")
        sys.exit(1)
    cfg = BotConfig(json.loads(path.read_text()))
    if not cfg.pools:
        log.error("No pools configured in config.json")
        sys.exit(1)
    # Low-1 (Pass 27): every on-chain-priced asset should carry a plausibility bound —
    # warn loudly if one is missing so a future pool can't silently ship fail-open.
    priced = set(cfg.reference_pools) | {p.compx_check_asset_id for p in cfg.pools if p.compx_check_asset_id}
    for aid in sorted(priced):
        if aid != cfg.usdc_asa_id and aid not in cfg.asset_price_bounds:
            log.warning(f"asset {aid} is priced on-chain but has no asset_price_bounds entry "
                        f"(fail-open for that layer) — add one to config.json")
    return cfg


# ── algod client ──────────────────────────────────────────────────────────────

def make_algod_client() -> algod.AlgodClient:
    url   = os.environ.get("ALGOD_URL", "https://mainnet-api.algonode.cloud")
    token = os.environ.get("ALGOD_TOKEN", "")
    return algod.AlgodClient(token, url, {"User-Agent": "magnetfi-oracle/2.0"})


# ── on-chain pool state ───────────────────────────────────────────────────────

def _decode_local_state(account_app_info: dict) -> dict[str, int]:
    """
    Decode a Tinyman v2 pool account's LOCAL state (under the AMM validator app)
    into a flat dict of str → int. Only uint values are extracted.

    Key fields used here (all uint64, in the pool account's local state):
      asset_1_id / asset_2_id        — the pool's two asset ids
      asset_1_reserves / asset_2_reserves — net tradeable reserves (exclude protocol fees)
      issued_pool_tokens             — circulating LP token supply (base units)
    """
    local = account_app_info.get("app-local-state", account_app_info.get("appLocalState", {}))
    kvs = local.get("key-value", local.get("keyValue", []))
    result: dict[str, int] = {}
    for item in kvs:
        key = base64.b64decode(item["key"]).decode("utf-8", errors="replace")
        val = item["value"]
        if val.get("type") == 2:   # uint
            result[key] = val.get("uint", 0)
    return result


def fetch_pool_state(client: algod.AlgodClient, pool_address: str, amm_app_id: int) -> dict[str, int]:
    """
    Read and decode a Tinyman v2 pool's reserves/LP supply from the pool ACCOUNT's
    local state under the shared AMM validator app, with retry.
    """
    for attempt in range(MAX_RETRIES):
        try:
            info = client.account_application_info(pool_address, amm_app_id)
            return _decode_local_state(info)
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            log.warning(f"algod error (attempt {attempt + 1}): {e}; retrying in {RETRY_DELAY}s")
            time.sleep(RETRY_DELAY)
    return {}   # unreachable


def _pool_reserves(state: dict[str, int], asset_id: int, quote_id: int) -> tuple[int, int]:
    """Return (reserve_of_asset, reserve_of_quote) base units from a decoded pool state,
    matching by the pool's on-chain asset_1_id / asset_2_id ordering."""
    a1, a2 = state.get("asset_1_id"), state.get("asset_2_id")
    if asset_id == a1 and quote_id == a2:
        return state["asset_1_reserves"], state["asset_2_reserves"]
    if asset_id == a2 and quote_id == a1:
        return state["asset_2_reserves"], state["asset_1_reserves"]
    raise ValueError(
        f"reference pool asset mismatch: pool holds {a1}/{a2}, wanted {asset_id}/{quote_id}"
    )


# ── on-chain price derivation (reference-pool graph rooted at USDC) ──────────────

def derive_asset_price_usdc(
    client: algod.AlgodClient, asset_id: int, cfg: BotConfig, memo: dict[int, float] | None = None
) -> float:
    """
    Price an asset in USDC purely from on-chain Tinyman pool reserves, walking a
    reference-pool graph until it reaches USDC. Recursive + memoized.

    Each reference_pools[asset] entry names a pool and the quote asset to price
    against; the asset's price = (quote_reserve/asset_reserve) × price(quote).
    """
    if memo is None:
        memo = {}
    if asset_id == cfg.usdc_asa_id:
        return 1.0
    if asset_id in memo:
        return memo[asset_id]

    ref = cfg.reference_pools.get(asset_id)
    if ref is None:
        raise ValueError(f"no reference pool configured for asset {asset_id}")

    state = fetch_pool_state(client, ref["pool_address"], cfg.amm_app_id)
    quote_id = ref["quote_asset_id"]
    asset_res, quote_res = _pool_reserves(state, asset_id, quote_id)
    if asset_res == 0 or quote_res == 0:
        raise ValueError(f"zero reserve in reference pool for asset {asset_id}")

    a_dec = cfg.asset_decimals[asset_id]
    q_dec = cfg.asset_decimals[quote_id]
    ratio = (quote_res / 10 ** q_dec) / (asset_res / 10 ** a_dec)   # price in quote units
    price = ratio * derive_asset_price_usdc(client, quote_id, cfg, memo)
    # Per-asset absolute plausibility bound (F3): a distorted reference-pool read
    # is rejected here instead of silently propagating into the composite LP price.
    bounds = cfg.asset_price_bounds.get(asset_id)
    if bounds and not (bounds[0] <= price <= bounds[1]):
        raise ValueError(f"derived price for asset {asset_id} = {price:.6f} outside sanity bounds {bounds}")
    memo[asset_id] = price
    return price


def compute_lp_price(pool: PoolConfig, pool_state: dict[str, int], price_a: float, price_b: float) -> int | None:
    """Compute LP token price in USDC, scaled × 1_000_000. None if pool state invalid."""
    lp_total = pool_state.get("issued_pool_tokens", 0)
    if lp_total == 0:
        log.warning(f"[{pool.label}] zero LP supply — skipping")
        return None

    # Map reserves by asset id, not position (F4) — correctness no longer depends on
    # the config ordering matching the pool's on-chain asset_1/asset_2 ordering.
    try:
        reserve_a, reserve_b = _pool_reserves(pool_state, pool.asset_a_id, pool.asset_b_id)
    except ValueError as e:
        log.warning(f"[{pool.label}] {e} — skipping")
        return None

    if reserve_a == 0 and reserve_b == 0:
        log.warning(f"[{pool.label}] zero reserves — skipping")
        return None

    tvl_a = (reserve_a / 10 ** pool.asset_a_decimals) * price_a
    tvl_b = (reserve_b / 10 ** pool.asset_b_decimals) * price_b
    pool_tvl = tvl_a + tvl_b

    lp_supply_display = lp_total / 10 ** LP_DECIMALS
    scaled_price = int((pool_tvl / lp_supply_display) * PRICE_SCALE)

    if scaled_price <= 0:
        log.warning(f"[{pool.label}] computed price ≤ 0 — skipping")
        return None
    return scaled_price


# ── CompX Flux oracle (second source / divergence guard) ────────────────────────

def read_compx_price(client: algod.AlgodClient, oracle_app_id: int, asset_id: int) -> tuple[float, int] | None:
    """
    Read an asset's USD price from CompX's on-chain Flux oracle.
    Box name = "prices" + uint64(asset_id); value = ABI tuple
    (uint64 assetId, uint64 price, uint64 lastUpdated), price scaled × 1e6.
    Returns (price_usdc, last_updated_ts) or None on any error.
    """
    try:
        name = b"prices" + int(asset_id).to_bytes(8, "big")
        box = client.application_box_by_name(oracle_app_id, name)
        raw = base64.b64decode(box["value"])
        if len(raw) < 24:
            return None
        # Verify the box's embedded assetId matches what we asked for (F6) — never
        # trust a price for the wrong/garbage asset as a valid cross-check.
        if int.from_bytes(raw[0:8], "big") != int(asset_id):
            log.warning(f"CompX box assetId mismatch for {asset_id}; ignoring cross-check value")
            return None
        price = int.from_bytes(raw[8:16], "big")
        updated = int.from_bytes(raw[16:24], "big")
        return price / PRICE_SCALE, updated
    except Exception as e:
        log.debug(f"CompX price read failed for asset {asset_id}: {e}")
        return None


def compx_cross_check(client: algod.AlgodClient, cfg: BotConfig, pool: PoolConfig,
                      derived_usdc: float) -> str:
    """
    Cross-check our on-chain-derived price of the pool's volatile asset against
    CompX's independent oracle. Returns one of:
      "ok"         — CompX fresh and agrees within the divergence limit
      "diverged"   — CompX fresh but disagrees beyond the limit (hard stop)
      "unverified" — CompX unavailable / stale / non-positive (cannot confirm)

    The caller treats "diverged" as a hard refuse, and "unverified" as a reason to
    only allow flat / small-decline posts (the strong guard is off — see update_pool).
    A pool with no CompX check configured returns "ok" (relies on TWAP + anchor only).
    """
    if not pool.compx_check_asset_id or not cfg.compx_oracle_app_id:
        return "ok"
    cx = read_compx_price(client, cfg.compx_oracle_app_id, pool.compx_check_asset_id)
    if cx is None:
        log.warning(f"[{pool.label}] CompX cross-check unavailable")
        return "unverified"
    cx_price, cx_updated = cx
    age = int(time.time()) - cx_updated
    if age > cfg.compx_max_age:
        log.warning(f"[{pool.label}] CompX price stale ({age}s > {cfg.compx_max_age}s)")
        return "unverified"
    if cx_price <= 0:
        log.warning(f"[{pool.label}] CompX price ≤ 0")
        return "unverified"
    divergence = abs(derived_usdc - cx_price) / cx_price
    if divergence > cfg.compx_divergence_limit:
        log.error(
            f"[{pool.label}] DIVERGENCE: derived ${derived_usdc:.6f} vs CompX ${cx_price:.6f} "
            f"= {divergence:.2%} > {cfg.compx_divergence_limit:.0%}; refusing to post (fail-stale)"
        )
        return "diverged"
    log.info(f"[{pool.label}] CompX cross-check OK: derived ${derived_usdc:.6f} vs CompX ${cx_price:.6f} (Δ{divergence:.2%})")
    return "ok"


# ── full price pipeline for one pool ────────────────────────────────────────────

def get_lp_price(client: algod.AlgodClient, pool: PoolConfig, cfg: BotConfig) -> tuple[int, bool] | None:
    """Read LP pool state, derive underlyings on-chain, compute LP price, apply sanity
    bounds + CompX cross-check. Returns (scaled_price, compx_verified), or None if it
    cannot price safely (incl. a fresh CompX divergence). compx_verified=False means
    CompX could not confirm this round — the caller then restricts to flat/small-decline posts."""
    try:
        pool_state = fetch_pool_state(client, pool.pool_address, cfg.amm_app_id)
    except Exception as e:
        log.error(f"[{pool.label}] failed to fetch pool state: {e}")
        return None

    # Confirm the pool account holds the asset ids we expect (wrong pool_address guard).
    onchain_a = pool_state.get("asset_1_id", -1)
    onchain_b = pool_state.get("asset_2_id", -1)
    if onchain_a != pool.asset_a_id or onchain_b != pool.asset_b_id:
        log.error(
            f"[{pool.label}] pool asset mismatch: on-chain asset_1_id={onchain_a} "
            f"asset_2_id={onchain_b} vs config asset_a={pool.asset_a_id} asset_b={pool.asset_b_id}; refusing"
        )
        return None

    # Derive both underlyings' USD price purely on-chain.
    memo: dict[int, float] = {}
    try:
        price_a = derive_asset_price_usdc(client, pool.asset_a_id, cfg, memo)
        price_b = derive_asset_price_usdc(client, pool.asset_b_id, cfg, memo)
    except Exception as e:
        log.warning(f"[{pool.label}] on-chain price derivation failed: {e}")
        return None

    price = compute_lp_price(pool, pool_state, price_a, price_b)
    if price is None:
        return None

    # Absolute sanity bound — catches catastrophically wrong inputs the relative
    # on-chain deviation guard cannot (it only bounds movement vs prior).
    if pool.min_price > 0 and price < pool.min_price:
        log.error(f"[{pool.label}] price {price} below sanity floor {pool.min_price}; refusing to post")
        return None
    if pool.max_price > 0 and price > pool.max_price:
        log.error(f"[{pool.label}] price {price} above sanity ceiling {pool.max_price}; refusing to post")
        return None

    # Second source: cross-check the volatile underlying against CompX's oracle.
    compx_verified = True
    if pool.compx_check_asset_id and cfg.compx_oracle_app_id:
        check_price = memo.get(pool.compx_check_asset_id)
        if check_price is None:
            try:
                check_price = derive_asset_price_usdc(client, pool.compx_check_asset_id, cfg, memo)
            except Exception:
                check_price = None
        if check_price is None:
            compx_verified = False
        else:
            status = compx_cross_check(client, cfg, pool, check_price)
            if status == "diverged":
                return None
            compx_verified = (status == "ok")

    log.info(
        f"[{pool.label}] reserve_a={pool_state.get('asset_1_reserves')} "
        f"reserve_b={pool_state.get('asset_2_reserves')} "
        f"issued_lp={pool_state.get('issued_pool_tokens')} "
        f"price_a={price_a:.6f} price_b={price_b:.6f} raw_price={price} compx_verified={compx_verified}"
    )
    return price, compx_verified


# ── on-chain oracle read ──────────────────────────────────────────────────────

def read_onchain_price(client: algod.AlgodClient, oracle_app_id: int, pool_id: int) -> int:
    """Read the current on-chain price for pool_id from MagnetFi oracle global state."""
    try:
        key_b64 = base64.b64encode(b"lp_price_" + pool_id.to_bytes(8, "big")).decode()
        info = client.application_info(oracle_app_id)
        for item in info.get("params", {}).get("global-state", []):
            if item["key"] == key_b64:
                return item["value"].get("uint", 0)
    except Exception as e:
        log.debug(f"Failed to read on-chain price for pool {pool_id}: {e}")
    return 0


# ── transaction builder ───────────────────────────────────────────────────────

def post_price(client: algod.AlgodClient, oracle_app_id: int, bot_sk: str, bot_address: str,
               pool_id: int, price: int, dry_run: bool) -> bool:
    """Build and submit an update_lp_price ABI call. Returns True on success."""
    if dry_run:
        log.info(f"[DRY-RUN] would post pool_id={pool_id} price={price} to app {oracle_app_id}")
        return True

    method = Method.from_signature(UPDATE_LP_PRICE_SIG)
    signer = AccountTransactionSigner(bot_sk)

    for attempt in range(MAX_RETRIES):
        try:
            params = client.suggested_params()
            params.fee = 1000
            params.flat_fee = True

            atc = AtomicTransactionComposer()
            atc.add_method_call(
                app_id=oracle_app_id, method=method, sender=bot_address,
                sp=params, signer=signer, method_args=[pool_id, price],
            )
            result = atc.execute(client, wait_rounds=4)
            log.info(f"pool_id={pool_id} price={price} confirmed in round "
                     f"{result.confirmed_round} txid={result.tx_ids[0]}")
            return True
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                log.error(f"Failed to post price for pool {pool_id} after {MAX_RETRIES} attempts: {e}")
                return False
            log.warning(f"Txn error (attempt {attempt + 1}): {e}; retrying in {RETRY_DELAY}s")
            time.sleep(RETRY_DELAY)
    return False


# ── single update cycle ───────────────────────────────────────────────────────

def update_pool(client: algod.AlgodClient, cfg: BotConfig, pool: PoolConfig,
                twap: TwapState, bot_sk: str, bot_address: str, dry_run: bool) -> None:
    """Run the full price pipeline for one pool and post to oracle if valid."""
    log.info(f"[{pool.label}] computing price ...")

    result = get_lp_price(client, pool, cfg)
    if result is None:
        log.warning(f"[{pool.label}] could not compute price — skipping update")
        return
    spot_price, compx_verified = result

    now = int(time.time())
    twap.add(pool.pool_id, now, spot_price, TWAP_WINDOW)

    # Fail-stale gate (P19-07): on thin history a single reading would dominate, so
    # don't post until the window has filled. The prior on-chain price stands.
    if twap.count(pool.pool_id) < MIN_TWAP_READINGS:
        log.info(f"[{pool.label}] only {twap.count(pool.pool_id)}/{MIN_TWAP_READINGS} readings — "
                 f"holding prior on-chain price (fail-stale)")
        return

    final_price = twap.twap(pool.pool_id, spot_price)

    # Asymmetric divergence check: only block upward price spikes (potential manipulation);
    # let drops through so the oracle does not go stale during a genuine decline.
    if final_price > 0 and spot_price > final_price:
        upward_spread = (spot_price - final_price) / final_price
        if upward_spread > DIVERGENCE_LIMIT:
            log.warning(f"[{pool.label}] spot spike {upward_spread:.2%} above TWAP "
                        f"(spot={spot_price} twap={final_price}); possible manipulation, skipping")
            return
    elif final_price > 0 and spot_price < final_price:
        downward_spread = (final_price - spot_price) / final_price
        if downward_spread > DIVERGENCE_LIMIT:
            log.info(f"[{pool.label}] spot {downward_spread:.2%} below TWAP — "
                     f"posting TWAP ({final_price}) to reflect drop gradually")

    onchain = read_onchain_price(client, cfg.oracle_app_id, pool.pool_id)
    if onchain > 0:
        pct_change = abs(final_price - onchain) / onchain
        log.info(f"[{pool.label}] on-chain={onchain} → new={final_price} (Δ{pct_change:+.2%})")

    # F1/F5: when CompX could not verify this round, the strong divergence guard is OFF —
    # only allow flat / small declines, never an increase or a large drop (fail-stale).
    if not compx_verified:
        if onchain <= 0:
            log.warning(f"[{pool.label}] CompX unverified and no prior on-chain price — holding (fail-stale)")
            return
        if final_price > onchain:
            log.warning(f"[{pool.label}] CompX unverified; would raise {onchain}→{final_price} — refusing (fail-stale)")
            return
        drop = (onchain - final_price) / onchain
        if drop > UNVERIFIED_MAX_DROP:
            log.warning(f"[{pool.label}] CompX unverified; would drop {drop:.1%} (> {UNVERIFIED_MAX_DROP:.0%}) — refusing (fail-stale)")
            return
        log.info(f"[{pool.label}] CompX unverified — posting flat/small decline only")

    if not post_price(client, cfg.oracle_app_id, bot_sk, bot_address, pool.pool_id, final_price, dry_run):
        log.error(f"[{pool.label}] price post failed")


# ── main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="MagnetFi v2 LP Oracle Bot")
    parser.add_argument("--dry-run", action="store_true", help="compute prices but do not post")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="config.json path")
    parser.add_argument("--once", action="store_true", help="run once then exit (for cron use)")
    args = parser.parse_args()

    cfg = load_config(Path(args.config))
    client = make_algod_client()
    twap = TwapState(STATE_FILE)

    if cfg.oracle_app_id == 0 and not args.dry_run:
        log.error("oracle_app_id must be set in config.json or ORACLE_APP_ID env var (unless --dry-run)")
        sys.exit(1)

    bot_sk = bot_address = ""
    if not args.dry_run:
        bot_mnemonic = os.environ.get("BOT_MNEMONIC", "")
        if not bot_mnemonic:
            log.error("BOT_MNEMONIC environment variable not set")
            sys.exit(1)
        bot_sk = mnemonic.to_private_key(bot_mnemonic)
        bot_address = account.address_from_private_key(bot_sk)
        log.info(f"Oracle bot wallet: {bot_address}")

    log.info(f"Oracle app ID:     {cfg.oracle_app_id}")
    log.info(f"AMM validator app: {cfg.amm_app_id}")
    log.info(f"CompX oracle app:  {cfg.compx_oracle_app_id}")
    log.info(f"Pools configured:  {[p.label for p in cfg.pools]}")
    if args.dry_run:
        log.info("DRY-RUN mode — no transactions will be submitted")

    def run_once() -> None:
        for pool in cfg.pools:
            try:
                update_pool(client, cfg, pool, twap, bot_sk, bot_address, args.dry_run)
            except Exception as e:
                log.exception(f"[{pool.label}] unhandled error: {e}")

    if args.once:
        run_once()
        return

    log.info(f"Starting main loop (interval={POLL_INTERVAL}s) ...")
    while True:
        cycle_start = time.time()
        run_once()
        elapsed = time.time() - cycle_start
        sleep_for = max(0.0, POLL_INTERVAL - elapsed)
        log.info(f"Cycle complete in {elapsed:.1f}s; sleeping {sleep_for:.0f}s")
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
