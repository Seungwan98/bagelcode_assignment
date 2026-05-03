---
name: korean-git-commit
description: Write, rewrite, or validate git commit messages using a Korean-first convention with only the commit type tag and unavoidable technical identifiers in English. Use when the user asks for commit rules, commit message creation, git commit wording, conventional commit replacement, or Korean-based commit messages like "[Feat] 첫 번째 커밋".
---

# Korean Git Commit

## Goal

Create concise commit messages that are Korean-first while keeping only necessary technical words in English.

Default format:

```text
[Type] 한글 요약

한글 본문. 필요하면 변경 이유, 영향, 검증을 적는다.

Tested: <검증 명령 또는 확인 내용>
Not-tested: <검증하지 못한 항목>
```

For tiny commits, one line is enough:

```text
[Feat] 첫 번째 커밋
```

## Allowed type tags

Use exactly one English tag in square brackets.

| Tag | Use for |
| --- | --- |
| `[Feat]` | 새 기능, 새 화면, 새 API, 새 사용자 흐름 |
| `[Fix]` | 버그 수정, 잘못된 동작 수정 |
| `[Docs]` | README, docs, 주석성 문서 변경 |
| `[Refactor]` | 동작 변경 없는 구조 개선 |
| `[Test]` | 테스트 추가/수정 |
| `[Chore]` | 설정, 빌드, 패키지, 도구, 정리 작업 |
| `[Style]` | 포맷팅, 네이밍, UI 스타일만 변경 |
| `[Perf]` | 성능 개선 |
| `[Security]` | 보안, secret, 권한, 취약점 대응 |
| `[Revert]` | 이전 커밋 되돌림 |
| `[WIP]` | 공유 전 임시 작업. 최종 제출/머지 전 사용하지 말 것 |

If multiple tags fit, choose the user-visible intent first:

1. Security
2. Fix
3. Feat
4. Refactor
5. Test
6. Docs
7. Chore

## Language rule

- Write the subject and body in Korean.
- Keep English only when it is a proper technical identifier or command: `Firebase`, `Next.js`, `SSE`, `API`, `pnpm test`, `README`, file paths, package names.
- Avoid English filler: use `추가`, not `add`; `수정`, not `update`; `정리`, not `cleanup`, unless it is a command/name.
- Keep the subject under 60 Korean characters when possible.
- Use a noun phrase or concise action phrase. Do not end with a period.

Good:

```text
[Feat] 에이전트 실행 대시보드 초안 추가
[Docs] Firebase 설정 가이드 정리
[Chore] 로컬 비밀값 gitignore 처리
[Fix] 사용자 개입 메시지 저장 누락 수정
```

Avoid:

```text
feat: add dashboard
[Feature] Dashboard 추가함.
[Feat] Add Firebase config
[Docs] 문서를 업데이트했습니다.
```

## Body guidance

Add a body when the change needs context.

Preferred body sections:

```text
[Feat] 사용자 개입 타임라인 추가

에이전트 간 메시지 흐름만으로는 사용자가 협업에 개입했다는 증거가 약해서,
사용자 지시를 별도 이벤트로 저장하고 타임라인에 노출한다.

Tested: pnpm test
Not-tested: 실제 Codex CLI adapter 연동
```

Rules:

- Explain why first, then what changed if needed.
- Keep Korean sentences short.
- Use `Tested:` and `Not-tested:` trailers in English because they are machine-scannable.
- Do not include fake verification.

## Workflow

1. Inspect the actual diff or user-provided change summary.
2. Pick one type tag from the allowed list.
3. Write a Korean subject.
4. Add a short Korean body only if it clarifies intent/risk.
5. Add `Tested:` / `Not-tested:` when verification matters.
6. If asked to run `git commit`, run validation first when possible.

## Validation

Use the bundled validator for commit messages when a message is available:

```bash
python3 .omx/skills/korean-git-commit/scripts/validate_commit_message.py /path/to/message.txt
```

Or validate inline text:

```bash
python3 .omx/skills/korean-git-commit/scripts/validate_commit_message.py --text "[Feat] 첫 번째 커밋"
```

If this skill is installed under `~/.codex/skills`, the same script can also be run from the installed path:

```bash
python3 ~/.codex/skills/korean-git-commit/scripts/validate_commit_message.py --text "[Feat] 첫 번째 커밋"
```

A valid message must:

- start with one allowed `[Type]` tag
- have Korean text in the subject unless the subject is only a technical identifier
- avoid lowercase conventional-commit prefixes like `feat:`
- avoid trailing period in the subject
