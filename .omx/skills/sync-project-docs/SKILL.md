---
name: sync-project-docs
description: Update and validate project guidance whenever AGENTS.md or docs/ must be brought up to date. Use when the user asks to 최신화/sync/update AGENTS.md, /docs, architecture docs, technical specs, Firebase/config docs, commit rules, README-adjacent project instructions, or post-change documentation alignment.
---

# Sync Project Docs

## Goal

Keep project operating guidance synchronized across root `AGENTS.md` and `docs/` after product, architecture, workflow, config, or commit-rule changes.

Default target files:

- `AGENTS.md`
- `docs/architecture.md` — 전체 흐름과 모듈 구조
- `docs/getting-started.md` — 처음 사용하는 사람이 빠르게 실행하는 방법
- `docs/configuration.md` — 설정값 설명 및 예시
- `docs/test-writing-guide.md` — 테스트 작성 규칙과 예시
- `docs/troubleshooting.md` — 자주 발생하는 문제와 해결 방법
- `docs/extending.md` — 기능 확장 방법 및 구조 설명

Create missing files when the project needs them. Do not invent implementation details that are not present in the repo or user request.

## Workflow

1. Inspect current state:
   - `pwd`
   - `find . -maxdepth 3 -type f` excluding dependency/build/runtime noise
   - existing `AGENTS.md`
   - existing `docs/*.md`
   - relevant config files such as `.gitignore`, `.env.example`, `config/*`
2. Identify what changed or what the user wants documented.
3. Update `AGENTS.md` with durable agent-facing rules only:
   - product intent
   - execution posture
   - architecture constraints
   - secret/config handling
   - commit policy
   - verification expectations
4. Update `docs/` with user/engineer-facing detail:
   - `architecture.md`: 전체 흐름, runtime flow, module boundaries
   - `getting-started.md`: 설치, 실행, 첫 demo flow
   - `configuration.md`: env, Firebase, CLI adapter, git ignore, commit config
   - `test-writing-guide.md`: test layers, examples, manual QA
   - `troubleshooting.md`: common failures and fixes
   - `extending.md`: new agents, adapters, persistence, UI/API extension
5. Keep docs consistent:
   - same product name
   - same stack choices
   - same MVP/non-goal boundaries
   - same secret policy
   - same commit convention
6. Run validation:
   - bundled `audit_project_docs.py`
   - `git diff --check` when inside a git repo
   - secret scan when config docs or env templates changed
7. Report changed files, validation evidence, and remaining gaps.

## Writing rules

- Prefer Korean explanations for project-specific guidance unless the repo uses English-only docs.
- Keep technical identifiers in English: `Next.js`, `Firebase`, `SSE`, `API`, `README`, file paths, commands.
- Keep `AGENTS.md` concise and directive; put long explanations in `docs/`.
- Do not commit real secrets or paste real Firebase keys into docs.
- Do not overwrite deeper nested `AGENTS.md` files unless they are in scope and inspected.
- Do not remove existing important instructions unless they conflict with newer user instructions.

## Required validation script

Run from the project root after edits:

```bash
python3 .omx/skills/sync-project-docs/scripts/audit_project_docs.py .
```

If this skill is installed under `~/.codex/skills`, the same audit can also be run from the installed path:

```bash
python3 ~/.codex/skills/sync-project-docs/scripts/audit_project_docs.py .
```

The audit checks for:

- root `AGENTS.md`
- `docs/` directory
- recommended docs files
- Firebase local config ignore rules when Firebase docs/config exist
- `.env.example` trackability expectation
- obvious secret patterns in committed docs/templates

## Output format

Final response should include:

```text
완료 파일:
- ...

검증:
- ...

남은 리스크:
- ...
```
