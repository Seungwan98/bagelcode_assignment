# Team Commit Hygiene Finalization Guide

- team: worker-1-web-worker-2-tmux-cli
- generated_at: 2026-04-30T09:10:46.633Z
- lore_commit_protocol_required: true
- runtime_commits_are_scaffolding: true

## Suggested Leader Finalization Prompt

```text
Team "worker-1-web-worker-2-tmux-cli" is ready for commit finalization. Treat runtime-originated commits (auto-checkpoints, merge/cherry-picks, cross-rebases, worker clean rebase scaffolds, leader integration signals, shutdown checkpoints) as temporary scaffolding rather than final history. Do not reuse operational commit subjects verbatim. Completed task subjects: Implement: 베이글코드 모바일 캐주얼팀 과제용 멀티 에이전트 협업 도구 계획을 작성하라. worker-1은 Web 기반 도구 계획에 집중. Rewrite or squash the operational history into clean Lore-format final commit(s) with intent-first subjects and relevant trailers. Use task subjects/results and shutdown diff reports to choose semantic commit boundaries and rationale.
```

## Commit Hygiene Vocabulary

### Operational commit kinds

- `auto_checkpoint` (auto-checkpoint) — A worker-local checkpoint commit created by the team runtime to preserve dirty worktree changes.
- `integration_merge` (integration merge) — A leader-side runtime merge commit that integrates a worker branch or checkpoint into the team branch.
- `integration_cherry_pick` (integration cherry-pick) — A leader-side runtime cherry-pick used when the normal worker merge path cannot be used cleanly.
- `cross_rebase` (cross-rebase) — A runtime rebase operation that moves worker work across the current leader branch baseline.
- `worker_clean_rebase` (worker clean rebase) — A runtime rebase that refreshes a clean worker branch onto the current leader branch baseline.
- `leader_integration_attempt` (leader integration attempt) — A leader-side integration attempt recorded for auditability even when it does not create a final semantic commit.
- `shutdown_checkpoint` (shutdown checkpoint) — A shutdown-time checkpoint commit that preserves remaining worker worktree changes before cleanup.
- `shutdown_merge` (shutdown merge) — A shutdown-time runtime merge that preserves worker changes on the leader branch before teardown.

### Operational commit statuses

- `applied` (applied) — The runtime operation changed repository history or preserved worker changes as intended.
- `noop` (no-op) — The runtime operation was unnecessary because there was no relevant change to preserve or integrate.
- `conflict` (conflict) — The runtime operation encountered conflicts that require human or leader-side reconciliation.
- `skipped` (skipped) — The runtime intentionally skipped the operation because prerequisites or safety checks were not met.

## Task Summary

- task-1 | status=completed | owner=worker-1 | subject=Implement: 베이글코드 모바일 캐주얼팀 과제용 멀티 에이전트 협업 도구 계획을 작성하라. worker-1은 Web 기반 도구 계획에 집중
  - description: Implement the core functionality for: 베이글코드 모바일 캐주얼팀 과제용 멀티 에이전트 협업 도구 계획을 작성하라. worker-1은 Web 기반 도구 계획에 집중하고, worker-2는 tmux 기반 CLI 도구 계획에 집중하라. 각 계획은 과제 조건 충족 방식, 사용자 관찰/개입 UX, 에이전트 간 메시징 프로토콜, 추천 기술스택, MVP 기능, README 실행 흐름, 장점/리스크, 3~5일 구현 범위를 포함하라. 최종 보고는 한국어로 간결하고 실전적인 과제 제출 관점으로 작성하라.
  - result_excerpt: - MVP 기능: 웹 워크스페이스 생성, 역할 기반 에이전트 등록, 작업 생성/배정/상태 관리, 에이전트 로그/메시지 타임라인, 사용자 개입 댓글/지시, 최종 요약 리포트 생성
- README 실행 흐름: 프로젝트 소개 → 설치/환경변수 설정 → 개발 서버 실행 → 워크스페이스 생성 → 작업 생성 → 에이전트 역할 선택 → 로그 확인 → 결과 요약 확인 → 한계/확장 방향
- 장점: 협업 과정을 시각화하기 쉬움, 과제 시연 …
- task-2 | status=failed | owner=worker-2 | subject=Test: 베이글코드 모바일 캐주얼팀 과제용 멀티 에이전트 협업 도구 계획을 작성하라. worker-1은 Web 기반 도구 계획에 집중하고, w
  - description: Write tests and verify: 베이글코드 모바일 캐주얼팀 과제용 멀티 에이전트 협업 도구 계획을 작성하라. worker-1은 Web 기반 도구 계획에 집중하고, worker-2는 tmux 기반 CLI 도구 계획에 집중하라. 각 계획은 과제 조건 충족 방식, 사용자 관찰/개입 UX, 에이전트 간 메시징 프로토콜, 추천 기술스택, MVP 기능, README 실행 흐름, 장점/리스크, 3~5일 구현 범위를 포함하라. 최종 보고는 한국어로 간결하고 실전적인 과제 제출 관점으로 작성하라.
  - error_excerpt: Blocked: no worker-2 plan artifact exists under .omx/plans/, and the workspace has no git/source tree or executable test harness to run regression checks against.

## Runtime Operational Ledger

- No runtime-originated commit activity recorded.

## Finalization Guidance

1. Treat `omx(team): ...` runtime commits as temporary scaffolding, not as the final PR history.
2. Reconcile checkpoint, merge/cherry-pick, cross-rebase, and shutdown checkpoint activity into semantic Lore-format final commit(s).
3. Use task outcomes, code diffs, and shutdown diff reports to name and scope the final commits.

## Recommended Next Steps

1. Inspect the current branch diff/log and identify which runtime-originated commits should be squashed or rewritten.
2. Derive semantic commit boundaries from completed task subjects, code diffs, and shutdown reports rather than from omx(team) operational commit subjects.
3. Create final commit messages in Lore format with intent-first subjects and only the trailers that add decision context.
