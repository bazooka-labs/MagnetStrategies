# Predict

The price-markets arm of Magnet Strategies, and the home of **VPL — Volatility
Prediction Ladder**.

Predict products are mUSD-denominated, hosted inside the Magnet Strategies app, and
built on the existing connect-wallet. They are user-to-user: the protocol never takes
the other side of a position, holds no inventory, and carries no directional risk.

**Status:** VPL shipped — contract, keeper and the `/predict` route are live. Contrast
[Hedge](../hedge/OVERVIEW.md), still at design stage.

> Shares its sector framing with [Hedge](../hedge/OVERVIEW.md), which houses a separate
> product line. The overlapping sections below are duplicated rather than cross-linked
> so this tree stands alone — the two will drift, and that is fine, because they
> describe different products.

---

## Why mUSD Is the Base Currency

Predict exists to give mUSD holders reasons to keep mUSD in their wallets rather than
redeeming it for USDC.

This is a claim about **holding behaviour, not price.** mUSD is a stablecoin — if it
works it is worth $1 forever, and no amount of product volume changes that. What
Predict moves is narrower and more honest:

| Lever | Mechanism |
|---|---|
| **Float** | mUSD sits in escrow for the life of a round and cannot be redeemed while it is there. A 24-hour entry window plus a 7-hour session produces real dwell time. |
| **Denomination lock-in** | Payouts are in mUSD, not USDC. A winner receives mUSD and faces the exit decision again rather than having exited automatically. Each round, some fraction stays. |
| **Entry demand** | Playing requires mUSD. Players arriving with USDC mint through the PSM (free, 1:1) to participate. |

What Predict does **not** do is increase mUSD's backing. Rake routes to the Magnet
Strategies treasury, not to PSM reserves — a deliberate choice trading direct backing
accrual for treasury flexibility. The treasury may route funds to the PSM at its
discretion; the contract has no opinion on it.

Supporting context: the PSM already charges 1% on mUSD→USDC redemption and 0% on mint.
Entry into mUSD is friction-free; exit is not. Predict adds reasons to stay on the near
side of that asymmetry.

---

## Ring-Fencing From MagnetFi

Predict consumes mUSD. It is never part of mUSD's issuance or solvency machinery.

- Predict contracts hold mUSD as **ordinary balance only**. They never mint, never
  burn, and hold no protocol role
- Predict never reads or writes MagnetFi state
- Predict runs its own oracle app and its own signing key. **It must never read the
  oracle MagnetFi liquidations depend on** — if it shared the vault price feed,
  manipulating a payout and manipulating protocol solvency would become the same action
- Rake flows one way: Predict → treasury. Nothing flows back

MagnetFi's core invariant — *circulating mUSD ≤ PSM USDC reserves* — is unaffected.
mUSD held in Predict escrow is circulating mUSD like any other; escrowing it neither
mints nor destroys it, so the invariant is untouched in both directions.

**Verified on-chain and asserted at bootstrap:** mUSD (`3615600399`) has freeze and
clawback set to the zero address, permanently and irreversibly. MagnetFi cannot freeze
or claw back Predict's escrow, so isolation holds in both directions. The contract
asserts both at bootstrap rather than resting on a one-time human check — decimals and
a unit name are forgeable by any third party's ASA; those two properties are not.

Note the separation is only as good as its weakest layer. Contract-level isolation does
not hold if the private keys sit on one machine — see
[OPERATIONS.md](./OPERATIONS.md#phase-1--local-current).

---

## Open Source Policy

**The Predict contracts and frontend are public**, in the same repo and under the same
terms as the rest of Magnet Strategies.

The reasoning is not ideological:

1. **The contract is public regardless.** Approval programs are readable on-chain, and
   any published client library carries the full ABI with it. Closed-sourcing an
   Algorand contract obscures nothing of substance — it converts a one-hour read into a
   one-day read.
2. **Trust is the binding constraint.** Predict's operator sets the rake, creates
   rounds, and runs the keeper that posts the settlement price deciding who wins. From
   a user's seat, a closed-source contract with an operator-supplied resolving price is
   indistinguishable from a rigged one. Open source converts *trust the operator* into
   *verify the contract, then trust only the price feed* — and the price feed is itself
   four published candles anyone can check against a chart.
3. **Consistency.** MagnetFi is public and it custodies real collateral and can
   liquidate people. A closed price market alongside an open lending protocol reads as
   concealment.

**Carve-out — off-chain operations may stay private.** The keeper's scheduling,
credentials, retry and failover are a separate service and not part of the public repo.
That is where operational edge legitimately lives.

What is *not* carved out: how the settled number is derived, how the attestation
preimage is built, and which venues are read. Those are published in
[ORACLE.md](./ORACLE.md) and implemented in [`keeper/vplkeeper/`](./keeper/), because
they are exactly what a user would need to verify a settlement themselves.

---

## Documents

| | |
|---|---|
| [VPL.md](./VPL.md) | Product design — conveyor, bands, payouts, strategy surface, and the reasoning behind each |
| [VPL_SPEC.md](./VPL_SPEC.md) | Implementation spec — state machine, ABI, math, invariants, edge cases |
| [ORACLE.md](./ORACLE.md) | Price service — sources, OHLC4, attestation format, trust model |
| [OPERATIONS.md](./OPERATIONS.md) | Deployment, key custody, the redeploy loop, the keeper migration plan |
| [contracts/](./contracts/) | Algorand Python implementation and its test suite |
| [keeper/](./keeper/) | Price reads, attestation signing, deployment and round tooling |

The user-facing page is `/predict` in the web app; the admin panel lives under it and
is gated on the admin wallet.
