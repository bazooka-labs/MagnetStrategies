"""Build entrypoint: compiles every contract under smart_contracts/ to artifacts/.

MUSD_ASSET_ID stays a TMPL_ placeholder in the TEAL and is substituted at DEPLOY time
(algokit-utils `deploy_time_params`), so one artifact serves every network and the
chosen asset is baked permanently into the deployed program. bootstrap is one-shot and
irreversible in a non-upgradeable contract, so the asset must not be trusted from a
call argument.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
ARTIFACTS = ROOT / "artifacts"


def build(out_dir: Path | None = None) -> int:
    out = out_dir or ARTIFACTS
    out.mkdir(parents=True, exist_ok=True)
    targets = [p for p in ROOT.iterdir() if p.is_dir() and (p / "contract.py").exists()]
    if not targets:
        print("no contracts found", file=sys.stderr)
        return 1
    for t in targets:
        print(f"building {t.name} ...")
        r = subprocess.run(
            [sys.executable, "-m", "puyapy", "--out-dir", str(out / t.name),
             str(t / "contract.py")],
            check=False,
        )
        if r.returncode != 0:
            return r.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(build())
