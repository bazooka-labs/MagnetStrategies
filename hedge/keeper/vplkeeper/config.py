"""Configuration and key loading.

Everything sensitive comes from the environment or a mode-600 file. Nothing is
hardcoded and nothing is logged — the one rule that matters here is that a secret must
never reach stdout, because these scripts get run in terminals that get screenshotted.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from nacl.signing import SigningKey

MUSD_MAINNET = 3_615_600_399

# ±0.5 / 1.25 / 2.25 / 3.5% of the reference, in bps multipliers of it.
DEFAULT_BAND_BOUNDS = (9650, 9775, 9875, 9950, 10050, 10125, 10225, 10350)
DEFAULT_RAKE_BPS = 400
DEFAULT_MIN_STAKE = 5_000_000        # 5 mUSD
PRICE_FEED_ID = 1                    # BTC/USD


def _require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"missing environment variable: {name}")
    return v


@dataclass(frozen=True)
class Config:
    network: str                     # "localnet" | "testnet" | "mainnet"
    musd_asset_id: int
    app_id: int                      # 0 before deployment
    oracle_key_path: Path
    app_spec_path: Path

    @property
    def is_mainnet(self) -> bool:
        return self.network == "mainnet"


def load() -> Config:
    network = os.environ.get("VPL_NETWORK", "localnet")
    default_musd = MUSD_MAINNET if network == "mainnet" else 0
    return Config(
        network=network,
        musd_asset_id=int(os.environ.get("VPL_MUSD_ASSET_ID", default_musd)),
        app_id=int(os.environ.get("VPL_APP_ID", 0)),
        oracle_key_path=Path(os.environ.get(
            "VPL_ORACLE_KEY", Path.home() / ".vpl" / "oracle.key")),
        app_spec_path=Path(os.environ.get(
            "VPL_APP_SPEC",
            Path(__file__).parent.parent.parent
            / "contracts/smart_contracts/artifacts/vpl/VPL.arc56.json")),
    )


def load_oracle_key(path: Path) -> SigningKey:
    """32 raw seed bytes, mode 600.

    Refuses a world- or group-readable file. This key cannot move funds directly, but
    because lock/resolve are permissionless, whoever holds it can settle a round at a
    price of their choosing with no other credential — it is the most valuable secret
    in the system.
    """
    if not path.exists():
        raise SystemExit(
            f"no oracle key at {path}\n"
            f"  generate one with:  python -m vplkeeper.config genkey {path}"
        )
    mode = path.stat().st_mode & 0o077
    if mode:
        raise SystemExit(f"{path} is group/world readable ({oct(mode)}); chmod 600 it")
    seed = path.read_bytes()
    if len(seed) != 32:
        raise SystemExit(f"{path}: expected 32 seed bytes, got {len(seed)}")
    return SigningKey(seed)


def generate_oracle_key(path: Path) -> bytes:
    """Create a new key. Returns the PUBLIC key — the only half that should ever be
    copied anywhere, since it is what bootstrap takes and what a migration rotates."""
    if path.exists():
        raise SystemExit(f"{path} already exists; refusing to overwrite")
    path.parent.mkdir(parents=True, exist_ok=True)
    key = SigningKey.generate()
    path.write_bytes(bytes(key._seed))
    path.chmod(0o600)
    return bytes(key.verify_key)


if __name__ == "__main__":
    import sys

    if len(sys.argv) == 3 and sys.argv[1] == "genkey":
        pub = generate_oracle_key(Path(sys.argv[2]))
        print(f"oracle key written to {sys.argv[2]} (mode 600)")
        print(f"public key (safe to copy): {pub.hex()}")
    else:
        raise SystemExit("usage: python -m vplkeeper.config genkey <path>")
