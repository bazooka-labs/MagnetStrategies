#!/usr/bin/env python3
"""
Secret scanner for the MagnetStrategies repo.

Blocks Algorand mnemonics and other credentials from being committed / pushed.
Shared by the pre-commit hook (.githooks/pre-commit) and CI (.github/workflows/secret-scan.yml).

Usage:
    scan_secrets.py --staged     # scan staged file content (pre-commit hook)
    scan_secrets.py [paths...]    # scan given paths, or all tracked files (CI / manual)

Exit code 1 if any secret is found, 0 otherwise.

To intentionally allow a specific line (rare — e.g. a documented test vector), append:
    pragma: allowlist secret
The 25-word Algorand-mnemonic check is checksum-validated with algosdk when available, so
random 25-word prose is NOT flagged; when algosdk is missing it falls back to flagging the
candidate for manual review (CI always has algosdk, making it definitive there).
"""

from __future__ import annotations

import re
import subprocess
import sys

ALLOWLIST = "pragma: allowlist secret"
MAX_BYTES = 1_000_000  # skip files larger than ~1MB

# A run of 25 short lowercase words on one line = candidate Algorand mnemonic.
MNEMONIC_RE = re.compile(r"(?:[a-z]{3,10}[ ]+){24}[a-z]{3,10}")
PEM_RE = re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----")
# hardcoded credential assignment: key = "value" / key: 'value'
ASSIGN_RE = re.compile(
    r"(?i)\b(mnemonic|seed_?phrase|passphrase|private_?key|secret_?key|"
    r"api_?key|access_?token|auth_?token)\b\s*[:=]\s*[\"'][^\"']{12,}[\"']"
)


def _validate_mnemonic(candidate: str) -> bool | None:
    """True = checksum-valid Algorand mnemonic; False = not; None = can't validate (no algosdk)."""
    try:
        from algosdk import mnemonic  # noqa: PLC0415
    except Exception:
        return None
    words = candidate.split()
    if len(words) != 25:
        return None
    try:
        mnemonic.to_private_key(" ".join(words))
        return True
    except Exception:
        return False


def scan_text(text: str) -> list[tuple[int, str]]:
    findings: list[tuple[int, str]] = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if ALLOWLIST in line:
            continue
        for m in MNEMONIC_RE.finditer(line):
            valid = _validate_mnemonic(m.group(0))
            if valid is True:
                findings.append((lineno, "Algorand mnemonic (checksum-valid)"))
            elif valid is None:
                findings.append((lineno, "possible 25-word mnemonic (install algosdk to confirm)"))
            # valid is False -> random word run, not a mnemonic -> ignore
        if PEM_RE.search(line):
            findings.append((lineno, "PEM private key block"))
        if ASSIGN_RE.search(line):
            findings.append((lineno, "hardcoded credential assignment"))
    return findings


def _staged_files() -> list[str]:
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
        capture_output=True, text=True, check=True,
    ).stdout
    return [f for f in out.splitlines() if f]


def _staged_content(path: str) -> str | None:
    res = subprocess.run(["git", "show", f":{path}"], capture_output=True)
    if res.returncode != 0:
        return None
    try:
        if len(res.stdout) > MAX_BYTES:
            return None
        return res.stdout.decode("utf-8")
    except UnicodeDecodeError:
        return None  # binary


def _tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [f for f in out.splitlines() if f]


def _disk_content(path: str) -> str | None:
    try:
        with open(path, "rb") as fh:
            data = fh.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            return None
        return data.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def main(argv: list[str]) -> int:
    staged = "--staged" in argv
    paths = [a for a in argv if not a.startswith("--")]

    if staged:
        files = _staged_files()
        get = _staged_content
    else:
        files = paths or _tracked_files()
        get = _disk_content

    hits: list[str] = []
    for path in files:
        text = get(path)
        if text is None:
            continue
        for lineno, reason in scan_text(text):
            hits.append(f"  {path}:{lineno}: {reason}")

    if hits:
        sys.stderr.write(
            "\n\U0001F6D1  Potential secret(s) detected — commit blocked:\n"
            + "\n".join(hits)
            + "\n\nIf this is a false positive, append '# " + ALLOWLIST + "' to the line,\n"
            "or remove the secret. NEVER commit a real mnemonic/key (public repo).\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
