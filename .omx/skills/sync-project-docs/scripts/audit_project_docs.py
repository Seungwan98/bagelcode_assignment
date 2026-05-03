#!/usr/bin/env python3
"""Audit AGENTS.md and docs/ synchronization basics.

Usage:
  audit_project_docs.py [project_root]
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

REQUIRED_DOCS = [
    "docs/architecture.md",
    "docs/getting-started.md",
    "docs/configuration.md",
    "docs/test-writing-guide.md",
    "docs/troubleshooting.md",
    "docs/extending.md",
]
RECOMMENDED_DOCS: list[str] = []
SECRET_PATTERNS = [
    re.compile(r"AIza[0-9A-Za-z_-]{20,}"),
    re.compile(r"-----BEGIN PRIVATE KEY-----"),
    re.compile(r'"private_key"\s*:'),
    re.compile(r'"client_email"\s*:\s*"[^"\s]+@[^"\s]+"'),
]


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def is_git_repo(root: Path) -> bool:
    return subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def git_check_ignore(root: Path, rel: str) -> bool | None:
    if is_git_repo(root):
        result = subprocess.run(
            ["git", "-C", str(root), "check-ignore", "-q", rel],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return result.returncode == 0

    # `git check-ignore` needs a repository to evaluate negation/order rules
    # consistently. For projects not yet initialized with git, mirror only the
    # root .gitignore into a temporary repo and evaluate the same relative path.
    gitignore = root / ".gitignore"
    if not gitignore.exists():
        return False
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        shutil.copy2(gitignore, tmp / ".gitignore")
        subprocess.run(["git", "-C", str(tmp), "init", "--quiet"], check=True)
        result = subprocess.run(
            ["git", "-C", str(tmp), "check-ignore", "-q", rel],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    errors: list[str] = []
    warnings: list[str] = []

    if not (root / "AGENTS.md").exists():
        errors.append("missing root AGENTS.md")
    if not (root / "docs").is_dir():
        errors.append("missing docs/ directory")

    for rel in REQUIRED_DOCS:
        if not (root / rel).exists():
            errors.append(f"missing required doc: {rel}")
    for rel in RECOMMENDED_DOCS:
        if not (root / rel).exists():
            warnings.append(f"missing recommended doc: {rel}")

    agents = read(root / "AGENTS.md")
    if agents and "docs/" not in agents:
        warnings.append("AGENTS.md does not mention docs/ maintenance")
    if agents and "commit" not in agents.lower() and "커밋" not in agents:
        warnings.append("AGENTS.md does not mention commit policy")

    docs_text = "\n".join(read(root / rel) for rel in REQUIRED_DOCS + RECOMMENDED_DOCS)
    for pattern in SECRET_PATTERNS:
        if pattern.search(docs_text):
            errors.append(f"possible secret pattern in docs/templates: {pattern.pattern}")

    firebase_related = any((root / rel).exists() for rel in ["docs/configuration.md", "config/firebase.example.json"])
    if firebase_related:
        for rel in ["config/firebase.local.json", "config/firebase.admin.local.json", "config/firebase-service-account-prod.json", ".env.local"]:
            ignored = git_check_ignore(root, rel)
            if ignored is False:
                errors.append(f"Firebase/local secret path is not ignored: {rel}")

    if (root / ".env.example").exists():
        ignored = git_check_ignore(root, ".env.example")
        if ignored is True:
            errors.append(".env.example is ignored but should be trackable")

    for warning in warnings:
        print(f"WARN: {warning}")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print("PASS: project docs audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
