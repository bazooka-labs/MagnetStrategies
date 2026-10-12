from algopy import ARC4Contract, arc4

# ── Why this exists ───────────────────────────────────────────────────────────
#
# `ed25519verify_bare` costs exactly 1900 opcode budget units (measured on
# mainnet via simulate). One application call affords 700, and budget POOLS
# across the calls in a group. The relay oracle therefore cannot verify a
# signature out of its own allowance, and must buy more.
#
# It buys it by issuing inner application calls, each of which adds 700 to the
# pool (net ~682 after the callee's own overhead). It cannot call ITSELF to do
# that — the AVM rejects self-recursion outright ("attempt to self-call",
# measured — so this is a separate app rather than a style choice.
#
# A public no-op app already exists on mainnet (305162725) and would work. We
# deploy our own instead, because this sits in the liquidation path: depending
# on an app somebody else can delete would put their key in the way of our
# liquidations.
#
# ── Why it is permanent ───────────────────────────────────────────────────────
#
# No update or delete method is declared. An ARC4Contract rejects any
# OnCompletion it does not handle, so this app is **non-updatable and
# non-deletable by anyone, including us**. That is deliberate: once the oracle
# references it, an admin who could delete it could brick price posting — which
# means bricking liquidation — with no recourse.
#
# It holds no state, needs no funding (inner calls work from an unfunded app at
# fee 0 — the CALLER covers them by fee pooling), and does nothing. Doing
# nothing is the entire specification.


class OpUp(ARC4Contract):
    """A no-op whose only purpose is to contribute 700 opcode budget per call."""

    @arc4.abimethod(create="require")
    def deploy(self) -> None:
        """Create. Takes nothing and stores nothing."""

    @arc4.baremethod(allow_actions=["NoOp"])
    def noop(self) -> None:
        """
        Approve any bare NoOp, from anyone.

        Bare rather than an ABI method so the caller's inner transaction needs
        no application arguments at all.
        """
