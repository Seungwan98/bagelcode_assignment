#!/usr/bin/env python3
"""Validate Korean-first git commit messages.

Usage:
  validate_commit_message.py COMMIT_MSG_FILE
  validate_commit_message.py --text "[Feat] 첫 번째 커밋"
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ALLOWED_TAGS = {
    "Feat",
    "Fix",
    "Docs",
    "Refactor",
    "Test",
    "Chore",
    "Style",
    "Perf",
    "Security",
    "Revert",
    "WIP",
}

HANGUL_RE = re.compile(r"[가-힣]")
CONVENTIONAL_PREFIX_RE = re.compile(
    r"^(feat|fix|docs|refactor|test|chore|style|perf|security|revert)(\(.+\))?!?:",
    re.IGNORECASE,
)
TAG_RE = re.compile(r"^\[([A-Za-z]+)\]\s+(.+)$")


def load_message(args: argparse.Namespace) -> str:
    if args.text is not None:
        return args.text
    if args.file is None:
        raise SystemExit("error: provide a commit message file or --text")
    return Path(args.file).read_text(encoding="utf-8")


def validate(message: str) -> list[str]:
    errors: list[str] = []
    stripped = message.strip("\n")
    if not stripped.strip():
        return ["commit message is empty"]

    lines = stripped.splitlines()
    subject = lines[0].strip()

    if CONVENTIONAL_PREFIX_RE.match(subject):
        errors.append("subject must use [Type] Korean style, not conventional prefix like feat:")

    match = TAG_RE.match(subject)
    if not match:
        errors.append("subject must start with an allowed tag like [Feat] ")
        return errors

    tag, title = match.groups()
    if tag not in ALLOWED_TAGS:
        errors.append(f"unsupported tag [{tag}]; allowed: {', '.join(sorted(ALLOWED_TAGS))}")

    if not title.strip():
        errors.append("subject after tag is empty")

    if subject.endswith((".", "。")):
        errors.append("subject must not end with a period")

    if len(title) > 80:
        errors.append("subject body is too long; keep it concise")

    if not HANGUL_RE.search(title):
        # Allow rare technical-only subjects, but warn as error for this skill's Korean-first convention.
        errors.append("subject should be Korean-first and include Hangul text")

    if len(lines) > 1 and lines[1].strip() != "":
        errors.append("second line must be blank when a body is present")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", nargs="?")
    parser.add_argument("--text")
    args = parser.parse_args()

    message = load_message(args)
    errors = validate(message)
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print("PASS: Korean git commit message is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
