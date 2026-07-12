from algopy import Account, ARC4Contract, UInt64, arc4


class MockVault(ARC4Contract):
    """
    Minimal stand-in for the real Vault, for PSMv3 tests only.

    PSM.issue_musd / receive_musd require the caller to be the registered vault app address
    (Txn.sender == vault app account). This tiny app can be registered as the PSM's vault and
    then drive those two methods with controlled arguments, so the invariant, backing, and
    freeze logic can be unit-tested deterministically without the full vault/oracle/LP stack.

    NOT a production contract.
    """

    @arc4.abimethod(allow_actions=["NoOp"], create="require")
    def create(self) -> None:
        pass

    @arc4.abimethod
    def call_issue(self, psm_app: UInt64, recipient: Account, amount: UInt64) -> None:
        arc4.abi_call(
            "issue_musd(address,uint64)void",
            recipient,
            amount,
            app_id=psm_app,
        )

    @arc4.abimethod
    def call_receive(self, psm_app: UInt64, amount: UInt64) -> None:
        arc4.abi_call(
            "receive_musd(uint64)void",
            amount,
            app_id=psm_app,
        )
