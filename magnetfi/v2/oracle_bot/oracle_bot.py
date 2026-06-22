"""
MagnetFi v2 LP Oracle Bot

Posts TWAP-smoothed LP token prices to the on-chain LP Oracle contract every 5 minutes.

Price pipeline per pool:
  1. Read pool reserves + issued LP supply from the pool ACCOUNT's local state under
     the shared Tinyman v2 AMM validator app (NOT a per-pool app's global state)
  2. Verify the pool's on-chain asset ids match config (guards against wrong pool_address)
  3. Fetch underlying asset USD prices from Vestige
  4. Compute pool TVL and price per LP token (scaled × 1_000_000)
  5. Apply an absolute price sanity bound (min_price/max_price)
  6. Apply 5-reading trapezoidal TWAP (≈25-minute window)
  7. Run asymmetric divergence check (block upward spikes; let drops through)
  8. Post to oracle contract if all checks pass

Usage:
  python oracle_bot.py [--dry-run] [--config config.json]

Environment variables required:
  BOT_MNEMONIC   — oracle bot wallet mnemonic (25 words)
  ALGOD_URL      — algod node URL (default: https://mainnet-api.algonode.cloud)
  ALGOD_TOKEN    — algod API token (default: empty for public nodes)
  ORACLE_APP_ID  — LP Oracle contract app ID (can also be in config.json)
"""

import argparse
import base64
import json
import logging
import os
import statistics
import sys
import time
from pathlib import Path

import requests
import algosdk
from algosdk import account, mnemonic
from algosdk.v2client import algod
from algosdk.transaction import wait_for_confirmation
from algosdk.abi import Method
from algosdk.atomic_transaction_composer import (
    AtomicTransactionComposer,
    AccountTransactionSigner,
    TransactionWithSigner,
)


# ── configuration ─────────────────────────────────────────────────────────────

DEFAULT_CONFIG_PATH = Path(__file__).parent / "config.json"
STATE_FILE = Path(__file__).parent / "twap_state.json"

VESTIGE_API = "https://api.vestigelabs.io"

# Tinyman v2 AMM validator app — ONE shared app for all pools on mainnet.
# Each pool is a separate ACCOUNT opted into this app; the pool's reserves and
# issued-LP supply live in that account's LOCAL state under this app id (NOT in a
# per-pool application's global state). Override via config "amm_validator_app_id".
TINYMAN_V2_VALIDATOR_APP_ID = 1002541853

TWAP_WINDOW      = 5       # number of readings for TWAP
MIN_TWAP_READINGS = 3      # fail-stale: don't post until the window has this many readings
POLL_INTERVAL    = 300     # seconds between updates (5 minutes)
DIVERGENCE_LIMIT = 0.15    # 15% max spread across price sources before skip
LP_DECIMALS      = 6       # Tinyman LP tokens have 6 decimal places
PRICE_SCALE      = 1_000_000   # on-chain price representation: 1.00 = 1_000_000

# Algod timeout / retry settings
ALGOD_TIMEOUT    = 10
MAX_RETRIES      = 3
RETRY_DELAY      = 5

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
        if len(history) > window:
            self.history[pool_id] = history[-window:]
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


# ── pool configuration ────────────────────────────────────────────────────────

class PoolConfig:
    """Per-pool parameters loaded from config.json."""
    __slots__ = (
        "pool_id",        # arbitrary unique id we assign; matches the pool_id key used in Vault/Oracle
        "pool_address",   # Tinyman v2 pool ACCOUNT address (holds reserves in local state under the AMM app)
        "asset_a_id",     # ASA ID of asset_1 in the pool (0 for ALGO) — must match Tinyman asset_1_id
        "asset_a_decimals",
        "asset_b_id",     # ASA ID of asset_2 in the pool — must match Tinyman asset_2_id
        "asset_b_decimals",
        "min_price",      # absolute sanity floor (scaled ×1e6); 0 disables
        "max_price",      # absolute sanity ceiling (scaled ×1e6); 0 disables
        "label",          # human-readable name e.g. "U/ALGO"
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
        self.label = d.get("label", f"pool_{self.pool_id}")


def load_config(path: Path) -> tuple[int, int, list[PoolConfig]]:
    """Returns (oracle_app_id, amm_validator_app_id, [PoolConfig])."""
    if not path.exists():
        log.error(f"Config file not found: {path}")
        sys.exit(1)
    raw = json.loads(path.read_text())
    oracle_app_id = int(raw.get("oracle_app_id", os.environ.get("ORACLE_APP_ID", 0)))
    if oracle_app_id == 0:
        log.error("oracle_app_id must be set in config.json or ORACLE_APP_ID env var")
        sys.exit(1)
    amm_app_id = int(raw.get("amm_validator_app_id", TINYMAN_V2_VALIDATOR_APP_ID))
    pools = [PoolConfig(p) for p in raw.get("pools", [])]
    if not pools:
        log.error("No pools configured in config.json")
        sys.exit(1)
    return oracle_app_id, amm_app_id, pools


# ── algod client ──────────────────────────────────────────────────────────────

def make_algod_client() -> algod.AlgodClient:
    url   = os.environ.get("ALGOD_URL", "https://mainnet-api.algonode.cloud")
    token = os.environ.get("ALGOD_TOKEN", "")
    return algod.AlgodClient(token, url, {"User-Agent": "magnetfi-oracle/1.0"})


# ── on-chain pool state ───────────────────────────────────────────────────────

def _decode_local_state(account_app_info: dict) -> dict[str, int]:
    """
    Decode a Tinyman v2 pool account's LOCAL state (under the AMM validator app)
    into a flat dict of str → int. Only uint values are extracted.

    Key fields used here (all uint64, in the pool account's local state):
      asset_1_reserves     — net tradeable reserve of asset_1 (already excludes protocol fees)
      asset_2_reserves     — net tradeable reserve of asset_2
      issued_pool_tokens   — circulating LP token supply (base units)
    """
    # algosdk returns the local state under "app-local-state" → "key-value".
    local = account_app_info.get("app-local-state", account_app_info.get("appLocalState", {}))
    kvs = local.get("key-value", local.get("keyValue", []))
    result: dict[str, int] = {}
    for item in kvs:
        key = base64.b64decode(item["key"]).decode("utf-8", errors="replace")
        val = item["value"]
        if val.get("type") == 2:   # uint
            result[key] = val.get("uint", 0)
    return result


def fetch_pool_state(
    client: algod.AlgodClient, pool_address: str, amm_app_id: int
) -> dict[str, int]:
    """
    Read and decode a Tinyman v2 pool's reserves/LP supply from the pool ACCOUNT's
    local state under the shared AMM validator app, with retry.

    NOTE: Tinyman v2 has no per-pool application. Each pool is an account opted into
    the single AMM validator app; its state lives in that account's local state.
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


# ── price feeds ───────────────────────────────────────────────────────────────

def fetch_vestige_price(asa_id: int) -> float | None:
    """
    Fetch USD price for an ASA from Vestige.
    Returns None on any error (caller falls back to on-chain computation).
    asa_id = 0 means ALGO.
    """
    try:
        if asa_id == 0:
            url = f"{VESTIGE_API}/v1/assets/0/price"
        else:
            url = f"{VESTIGE_API}/v1/assets/{asa_id}/price"
        resp = requests.get(url, timeout=ALGOD_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        price = float(data.get("price_usdc", 0))
        return price if price > 0 else None
    except Exception as e:
        log.debug(f"Vestige price fetch failed for ASA {asa_id}: {e}")
        return None


def compute_lp_price(
    pool: PoolConfig,
    pool_state: dict[str, int],
    price_a: float,
    price_b: float,
) -> int | None:
    """
    Compute LP token price in mUSD, scaled × 1_000_000.

    Tinyman v2 pool-account local-state keys:
      asset_1_reserves    → net tradeable reserve of asset_a (already excludes protocol fees)
      asset_2_reserves    → net tradeable reserve of asset_b
      issued_pool_tokens  → circulating LP token base units outstanding

    Returns None if pool state is invalid (zero supply, zero reserves).
    """
    reserve_a = pool_state.get("asset_1_reserves", 0)
    reserve_b = pool_state.get("asset_2_reserves", 0)
    lp_total  = pool_state.get("issued_pool_tokens", 0)

    if lp_total == 0:
        log.warning(f"[{pool.label}] zero LP supply — skipping")
        return None
    if reserve_a == 0 and reserve_b == 0:
        log.warning(f"[{pool.label}] zero reserves — skipping")
        return None

    tvl_a = (reserve_a / 10 ** pool.asset_a_decimals) * price_a
    tvl_b = (reserve_b / 10 ** pool.asset_b_decimals) * price_b
    pool_tvl = tvl_a + tvl_b

    lp_supply_display = lp_total / 10 ** LP_DECIMALS
    lp_price_display  = pool_tvl / lp_supply_display
    scaled_price = int(lp_price_display * PRICE_SCALE)

    if scaled_price <= 0:
        log.warning(f"[{pool.label}] computed price ≤ 0 — skipping")
        return None

    return scaled_price


def get_lp_price(
    client: algod.AlgodClient,
    pool: PoolConfig,
    amm_app_id: int,
) -> int | None:
    """
    Full price pipeline for a single pool.

    Reads reserves + issued LP from the pool account's local state, prices the
    underlyings via Vestige, computes price-per-LP, and applies an absolute
    sanity bound. Returns the scaled price or None if it cannot price safely.
    """
    # Fetch pool state first (needed regardless of price source).
    try:
        pool_state = fetch_pool_state(client, pool.pool_address, amm_app_id)
    except Exception as e:
        log.error(f"[{pool.label}] failed to fetch pool state: {e}")
        return None

    # Defensive: confirm the pool account holds the asset ids we expect. A wrong
    # pool_address would otherwise produce a plausible-but-wrong price.
    onchain_a = pool_state.get("asset_1_id", -1)
    onchain_b = pool_state.get("asset_2_id", -1)
    if onchain_a != pool.asset_a_id or onchain_b != pool.asset_b_id:
        log.error(
            f"[{pool.label}] pool asset mismatch: on-chain "
            f"asset_1_id={onchain_a} asset_2_id={onchain_b} vs config "
            f"asset_a={pool.asset_a_id} asset_b={pool.asset_b_id}; refusing to price"
        )
        return None

    # Fetch underlying asset prices from Vestige.
    price_a = fetch_vestige_price(pool.asset_a_id)
    price_b = fetch_vestige_price(pool.asset_b_id)

    if price_a is None or price_b is None:
        log.warning(
            f"[{pool.label}] Vestige missing price: "
            f"asset_a={price_a} asset_b={price_b}; cannot compute LP price"
        )
        return None

    price = compute_lp_price(pool, pool_state, price_a, price_b)
    if price is None:
        return None

    # Absolute sanity bound — catches catastrophically wrong inputs that the
    # relative on-chain deviation guard cannot (it only bounds movement vs prior).
    if pool.min_price > 0 and price < pool.min_price:
        log.error(
            f"[{pool.label}] price {price} below sanity floor {pool.min_price}; refusing to post"
        )
        return None
    if pool.max_price > 0 and price > pool.max_price:
        log.error(
            f"[{pool.label}] price {price} above sanity ceiling {pool.max_price}; refusing to post"
        )
        return None

    log.info(
        f"[{pool.label}] reserve_a={pool_state.get('asset_1_reserves')} "
        f"reserve_b={pool_state.get('asset_2_reserves')} "
        f"issued_lp={pool_state.get('issued_pool_tokens')} "
        f"price_a={price_a:.6f} price_b={price_b:.6f} "
        f"raw_price={price}"
    )
    return price


# ── on-chain oracle read ──────────────────────────────────────────────────────

def read_onchain_price(client: algod.AlgodClient, oracle_app_id: int, pool_id: int) -> int:
    """Read the current on-chain price for pool_id from oracle global state."""
    try:
        key_bytes = b"lp_price_" + pool_id.to_bytes(8, "big")
        key_b64 = base64.b64encode(key_bytes).decode()
        info = client.application_info(oracle_app_id)
        for item in info.get("params", {}).get("global-state", []):
            if item["key"] == key_b64:
                return item["value"].get("uint", 0)
    except Exception as e:
        log.debug(f"Failed to read on-chain price for pool {pool_id}: {e}")
    return 0


# ── transaction builder ───────────────────────────────────────────────────────

def post_price(
    client: algod.AlgodClient,
    oracle_app_id: int,
    bot_sk: str,
    bot_address: str,
    pool_id: int,
    price: int,
    dry_run: bool,
) -> bool:
    """
    Build and submit an update_lp_price ABI call using AtomicTransactionComposer.
    Returns True on success, False on failure.
    """
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
                app_id=oracle_app_id,
                method=method,
                sender=bot_address,
                sp=params,
                signer=signer,
                method_args=[pool_id, price],
            )
            result = atc.execute(client, wait_rounds=4)
            log.info(
                f"pool_id={pool_id} price={price} confirmed in round "
                f"{result.confirmed_round} txid={result.tx_ids[0]}"
            )
            return True
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                log.error(f"Failed to post price for pool {pool_id} after {MAX_RETRIES} attempts: {e}")
                return False
            log.warning(f"Txn error (attempt {attempt + 1}): {e}; retrying in {RETRY_DELAY}s")
            time.sleep(RETRY_DELAY)

    return False


# ── single update cycle ───────────────────────────────────────────────────────

def update_pool(
    client: algod.AlgodClient,
    oracle_app_id: int,
    amm_app_id: int,
    pool: PoolConfig,
    twap: TwapState,
    bot_sk: str,
    bot_address: str,
    dry_run: bool,
) -> None:
    """Run the full price pipeline for one pool and post to oracle if valid."""
    log.info(f"[{pool.label}] computing price ...")

    spot_price = get_lp_price(client, pool, amm_app_id)
    if spot_price is None:
        log.warning(f"[{pool.label}] could not compute price — skipping update")
        return

    now = int(time.time())
    twap.add(pool.pool_id, now, spot_price, TWAP_WINDOW)

    # Fail-stale gate (P19-07): on thin history a single reading would dominate the
    # average, so don't post until the window has filled. The existing on-chain price
    # (admin anchor from add_pool, or the last good post) stands; if the bot stays
    # below the threshold past the freshness window the oracle goes stale, which blocks
    # borrows/liquidations — the safe failure mode, not posting a manipulable spot.
    if twap.count(pool.pool_id) < MIN_TWAP_READINGS:
        log.info(
            f"[{pool.label}] only {twap.count(pool.pool_id)}/{MIN_TWAP_READINGS} readings — "
            f"holding prior on-chain price (fail-stale)"
        )
        return

    final_price = twap.twap(pool.pool_id, spot_price)

    # Asymmetric divergence check: only block upward price spikes (potential manipulation).
    # Price drops are allowed through — silencing the bot during a genuine price decline
    # causes oracle staleness exactly when health-factor liquidations are most needed.
    if final_price > 0 and spot_price > final_price:
        upward_spread = (spot_price - final_price) / final_price
        if upward_spread > DIVERGENCE_LIMIT:
            log.warning(
                f"[{pool.label}] spot price spike {upward_spread:.2%} above TWAP — "
                f"spot={spot_price} twap={final_price}; possible manipulation, skipping"
            )
            return
    elif final_price > 0 and spot_price < final_price:
        downward_spread = (final_price - spot_price) / final_price
        if downward_spread > DIVERGENCE_LIMIT:
            log.info(
                f"[{pool.label}] spot {downward_spread:.2%} below TWAP — "
                f"posting TWAP ({final_price}) to reflect price drop gradually"
            )

    # Compare against current on-chain price (informational, not a gate)
    onchain = read_onchain_price(client, oracle_app_id, pool.pool_id)
    if onchain > 0:
        pct_change = abs(final_price - onchain) / onchain
        log.info(
            f"[{pool.label}] on-chain={onchain} → new={final_price} "
            f"(Δ{pct_change:+.2%})"
        )

    success = post_price(
        client, oracle_app_id, bot_sk, bot_address,
        pool.pool_id, final_price, dry_run,
    )
    if not success:
        log.error(f"[{pool.label}] price post failed")


# ── main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="MagnetFi v2 LP Oracle Bot")
    parser.add_argument("--dry-run", action="store_true", help="compute prices but do not post")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="config.json path")
    parser.add_argument("--once", action="store_true", help="run once then exit (for cron use)")
    args = parser.parse_args()

    oracle_app_id, amm_app_id, pools = load_config(Path(args.config))
    client = make_algod_client()
    twap = TwapState(STATE_FILE)

    bot_mnemonic = os.environ.get("BOT_MNEMONIC", "")
    if not bot_mnemonic:
        log.error("BOT_MNEMONIC environment variable not set")
        sys.exit(1)
    bot_sk     = mnemonic.to_private_key(bot_mnemonic)
    bot_address = account.address_from_private_key(bot_sk)
    log.info(f"Oracle bot wallet: {bot_address}")
    log.info(f"Oracle app ID:     {oracle_app_id}")
    log.info(f"AMM validator app: {amm_app_id}")
    log.info(f"Pools configured:  {[p.label for p in pools]}")
    if args.dry_run:
        log.info("DRY-RUN mode — no transactions will be submitted")

    def run_once() -> None:
        for pool in pools:
            try:
                update_pool(
                    client, oracle_app_id, amm_app_id, pool, twap,
                    bot_sk, bot_address, args.dry_run,
                )
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
