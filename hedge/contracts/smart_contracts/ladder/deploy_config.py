"""Deployment notes for the Ladder contract.

Deployment is a two-step handshake, matching the UVote pattern:

  1. create_application()  — sets admin to the deployer
  2. fund the app account, then bootstrap(...)

The app must hold enough ALGO before bootstrap for its own minimum balance plus the
mUSD opt-in (100,000 µALGO), plus round-box and payout-fee headroom. bootstrap() issues
an inner opt-in and will revert on an underfunded account.

bootstrap is ONE-SHOT and musd_asset_id is immutable afterwards. It asserts the asset's
decimals, unit name, total, and — critically — that clawback and freeze are the zero
address. That last pair is what makes MagnetFi unable to touch Hedge's escrow; on
Algorand those fields are irreversible once zeroed.

mUSD mainnet: 3615600399
"""

MUSD_MAINNET = 3615600399

# ±0.5 / 1.25 / 2.25 / 3.5% of the reference, in bps multipliers.
DEFAULT_BAND_BOUNDS = (9650, 9775, 9875, 9950, 10050, 10125, 10225, 10350)

DEFAULT_RAKE_BPS = 400      # 4%
DEFAULT_MIN_STAKE = 5_000_000  # 5 mUSD
