"""Algorand client, account loading, and the VPL app client."""

from __future__ import annotations

import json
import os

import algokit_utils
from algokit_utils import AlgorandClient, AppClient, AppClientParams, Arc56Contract

from vplkeeper.config import Config


def algorand(cfg: Config) -> AlgorandClient:
    if cfg.network == "mainnet":
        return AlgorandClient.main_net()
    if cfg.network == "testnet":
        return AlgorandClient.test_net()
    return AlgorandClient.default_localnet()


def account(client: AlgorandClient, env_var: str):
    """Load a signer from a 25-word mnemonic in the environment.

    Admin should be cold and only present when a parameter change or a sweep is
    actually being run — not exported in a shell profile alongside the keeper's.
    """
    mnemonic = os.environ.get(env_var)
    if not mnemonic:
        raise SystemExit(f"missing environment variable: {env_var}")
    acct = client.account.from_mnemonic(mnemonic=mnemonic.strip())
    client.set_signer(acct.address, acct.signer)
    return acct


def app_spec(cfg: Config) -> dict:
    if not cfg.app_spec_path.exists():
        raise SystemExit(
            f"no app spec at {cfg.app_spec_path}\n"
            f"  build it:  cd ../contracts && poetry run python -m smart_contracts build"
        )
    return json.loads(cfg.app_spec_path.read_text())


def app_client(cfg: Config, client: AlgorandClient, sender) -> AppClient:
    if not cfg.app_id:
        raise SystemExit("VPL_APP_ID is unset — deploy first")
    return AppClient(AppClientParams(
        app_spec=Arc56Contract.from_dict(app_spec(cfg)),
        algorand=client,
        app_id=cfg.app_id,
        default_sender=sender.address,
        default_signer=sender.signer,
    ))


def algo(micro: int) -> algokit_utils.AlgoAmount:
    return algokit_utils.AlgoAmount(micro_algo=micro)
