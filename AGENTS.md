# AgentBoard Project Instructions

## Product intent

AgentBoard is a Web Dashboard MVP for the BagelCode multi-agent collaboration assignment. The product must demonstrate that multiple AI coding agents can communicate with each other while a human user can observe and intervene in the process.

Primary proof points:

1. At least two agents exchange structured messages.
2. The user can observe collaboration through a dashboard timeline/status UI.
3. The user can intervene during an active run and the final artifact acknowledges that intervention.
4. The project runs from README instructions without requiring private API keys by default.

## Execution posture

- Optimize for ASAP delivery: build the thinnest end-to-end path first, then harden.
- Prefer a working vertical slice over broad scaffolding.
- Default demo mode must use deterministic mock agents so reviewers can run the project locally.
- Real Codex integrations are optional adapters, not blockers for the base demo.
- Keep every feature tied to assignment evidence: agent-agent messaging, user observation, user intervention, artifact output.

## Recommended stack

- Next.js App Router + TypeScript for the dashboard and API route handlers.
- Server-Sent Events for server-to-browser event streaming.
- POST APIs for user intervention and run controls.
- JSONL files under `.agentboard/runs/` for the MVP event/message store.
- Local file-backed mock mode remains the default persistence and demo execution path.

## Architecture rules

- Treat the event log as the source of truth for what happened during a run.
- Store messages as append-only records; do not mutate history except for derived state snapshots.
- Use a small adapter boundary for agents:
  - `MockAgentAdapter` for deterministic README demo.
  - `CliAgentAdapter` for optional local `codex` execution. In CLI mode, Planner/Engineer/Reviewer all use Codex unless a future adapter is explicitly added.
  - `TmuxSessionAdapter` for optional persistent Codex sessions. It must require AgentBoard transport markers, wait for a stable idle fallback before accepting missing `AGENTBOARD_DONE`, and surface Codex permission prompts as UI approval events.
- User interventions are first-class messages from `user` to an agent or `all`.
- Active runs must still accept user intervention messages; Orchestrator decides at the next checkpoint whether to continue, restart, or ask the user for clarification.
- Reviewer is a conservative quality gate only: it reports accuracy, omissions, risks, and recommendations back to Orchestrator instead of writing the user-facing final answer.
- Orchestrator owns the final user-facing answer after verifying the selected Agent outputs and any Reviewer quality report.
- Final artifacts must reference the run, participating agents, major messages, and any user intervention.

## Secret and local config handling

- Never commit real secrets, service-account JSON, `.env.local`, local config files, or generated runtime state.
- Commit only safe templates such as `.env.example`.
- Put local secrets and machine-specific config in `.env.local`; it is ignored by `.gitignore`.
- Service-account credentials and private keys must stay outside git.

## Documentation rules

Update `/docs` whenever architecture, protocol, config, or git workflow changes.

Required docs:

- `docs/architecture.md` — 전체 흐름과 모듈 구조.
- `docs/getting-started.md` — 처음 사용하는 사람이 빠르게 실행하는 방법.
- `docs/configuration.md` — 설정값 설명 및 예시.
- `docs/test-writing-guide.md` — 테스트 작성 규칙과 예시.
- `docs/troubleshooting.md` — 자주 발생하는 문제와 해결 방법.
- `docs/extending.md` — 기능 확장 방법 및 구조 설명.

## Git and commit policy

This repository may start without git initialized. Commit rules are summarized in `docs/configuration.md` and must use the Korean-first `[Type]` format.

Minimum commit hygiene:

1. Inspect changes before committing: `git status --short && git diff --check`.
2. Do not commit generated run state, local secret config, service accounts, `.env.local`, build artifacts, Xcode `DerivedData`/`.noindex` caches, or `xcuserdata`.
3. Keep commits small and evidence-focused.
4. Use Korean-first commit messages with one English type tag, e.g. `[Feat] 첫 번째 커밋`.
5. Use English only for the tag, commands, file paths, package names, and unavoidable technical identifiers.

## Verification before final reports

Before reporting completion, verify:

- Required docs exist.
- Local secret config paths are ignored.
- Templates do not contain real secrets.
- `.gitignore` covers generated run state, build output, dependency folders, secret files, and Xcode/Swift generated artifacts.
- Any implementation later added can be run from README in mock mode.
