"""Build entrypoint: compiles every contract under smart_contracts/ to artifacts/."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
ARTIFACTS = ROOT / "artifacts"


def build() -> int:
    ARTIFACTS.mkdir(exist_ok=True)
    targets = [p for p in ROOT.iterdir() if p.is_dir() and (p / "contract.py").exists()]
    if not targets:
        print("no contracts found", file=sys.stderr)
        return 1
    for t in targets:
        print(f"building {t.name} ...")
        r = subprocess.run(
            [sys.executable, "-m", "puyapy", "--out-dir",
             str(ARTIFACTS / t.name), str(t / "contract.py")],
            check=False,
        )
        if r.returncode != 0:
            return r.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(build())
