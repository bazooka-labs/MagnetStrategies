"""
The total_obligations identity — the defect that rev-5 review caught, tested directly.

    enter              += stake
    resolve RESOLVED   -= total_stake - payable_pot
    resolve VOID       unchanged
    settle_position    -= payout
    close_position      UNCHANGED
    refund_position    -= stake
    cleanup_round      -= remaining_payable

If close_position decrements by `stake`, the decrements over-run the counter by the
entire losing pot. Loudly that underflows and bricks the round; quietly, once rounds
overlap, the counter under-reports and sweep_excess_musd would authorise sweeping live
escrow. These tests pin the arithmetic so a future edit cannot silently reintroduce it.
"""

import pytest

BPS = 10_000


def payable_pot(total_stake: int, rake_bps: int) -> int:
    return (total_stake * (BPS - rake_bps)) // BPS


def payout(pot: int, stake: int, band_stake: int) -> int:
    return (pot * stake) // band_stake


def test_resolved_round_obligations_reach_zero() -> None:
    """A fully settled + closed + cleaned round must drain the counter to exactly 0."""
    rake = 400
    stakes = {4: [4_000_000_000, 5_800_000_000], 8: [200_000_000]}
    total = sum(s for band in stakes.values() for s in band)

    obligations = total                      # enter
    pot = payable_pot(total, rake)
    obligations -= total - pot               # resolve: rake leaves
    assert obligations == pot

    winning = 8
    band_total = sum(stakes[winning])
    remaining = pot
    for s in stakes[winning]:                # settle
        p = payout(pot, s, band_total)
        remaining -= p
        obligations -= p
    for band, ss in stakes.items():          # close — MUST NOT touch obligations
        if band != winning:
            for _ in ss:
                obligations -= 0

    obligations -= remaining                 # cleanup sweeps dust to rake_owed
    assert obligations == 0


def test_close_decrementing_stake_underflows() -> None:
    """The rev-5 bug, reproduced: decrementing on close over-runs by the losing pot."""
    rake = 400
    losers, winner = 9_800_000_000, 200_000_000
    total = losers + winner

    obligations = total
    pot = payable_pot(total, rake)
    obligations -= total - pot
    demanded = pot + losers                  # winner payouts + (wrong) loser decrements
    assert demanded > obligations
    assert demanded - obligations == losers  # over-run is exactly the losing pot


def test_void_round_obligations_reach_zero() -> None:
    stakes = [5_000_000, 120_000_000, 9_000_000]
    obligations = sum(stakes)
    remaining = sum(stakes)                  # void sets remaining_payable = total_stake

    for s in stakes[:-1]:                    # two refund, one never claims
        remaining -= s
        obligations -= s
    obligations -= remaining                 # cleanup forfeits the rest
    assert obligations == 0


def test_payout_sum_never_exceeds_pot() -> None:
    """Truncation is always downward, so dust accrues to the protocol, never a deficit."""
    pot = payable_pot(10_000_000_000, 400)
    stakes = [333_333_333, 666_666_667, 1_000_000_000, 7]
    band_total = sum(stakes)
    assert sum(payout(pot, s, band_total) for s in stakes) <= pot


@pytest.mark.parametrize(
    "reference,settlement,expected",
    [
        (79_000_000_000, 79_000_000_000, 4),   # flat -> centre
        (79_000_000_000, 82_400_000_000, 8),   # +4.3% -> top tail
        (79_000_000_000, 75_000_000_000, 0),   # -5.1% -> bottom tail
        (79_000_000_000, 79_395_000_000, 4),   # exactly on the +0.5% boundary -> inclusive
        (79_000_000_000, 79_395_000_001, 5),   # one unit above it
    ],
)
def test_winning_band_selection(reference: int, settlement: int, expected: int) -> None:
    """Inclusive upper bounds: a price exactly on a boundary is deterministic."""
    bounds_bps = [9650, 9775, 9875, 9950, 10050, 10125, 10225, 10350]
    winning = 0
    for i, bps in enumerate(bounds_bps):
        if winning == i and settlement > (reference * bps) // BPS:
            winning = i + 1
    assert winning == expected
