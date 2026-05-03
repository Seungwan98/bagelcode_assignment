# AgentBoard

AI coding agents가 서로 메시지를 주고받고, 사용자가 그 협업 과정을 관찰하고 개입할 수 있는 Web Dashboard MVP입니다. 기본 실행은 deterministic mock agents를 사용하므로 private API key나 실제 AI CLI 없이 바로 확인할 수 있습니다.

## 과제 조건 충족 요약

| 과제 조건 | AgentBoard 구현 |
| --- | --- |
| 두 개 이상의 AI Agent가 메시지를 주고받음 | Orchestrator가 Planner, Engineer, Reviewer에게 structured assignment/handoff message를 보내고, 각 Agent 결과가 다음 Agent와 Orchestrator 검증 단계에 전달됩니다. |
| 사용자가 협업 과정을 관찰 가능 | 4분할 Agent chat panel, SSE 기반 timeline, `Logs` drawer, raw event modal로 Agent 상태와 메시지 흐름을 확인합니다. |
| 사용자가 협업 과정에 개입 가능 | 실행 중 추가 지시, 현재 작업 취소, Codex 권한 승인/거절, 안전 명령 auto approval allowlist를 제공합니다. |
| 통신 방식/UI/프로토콜 자유 | Next.js App Router, Server-Sent Events, POST API, append-only JSONL event/message store를 사용합니다. |
| README대로 실행 | `mock` mode가 기본값이며 `npm install && npm run dev`만으로 실행됩니다. |

## Quick Start: Mock Demo

전제 조건:

- Node.js 20.9 이상
- npm

```bash
npm install
npm run dev
```

브라우저에서 접속합니다.

```text
http://localhost:3000
```

Mock demo는 외부 key, Codex 로그인, tmux 설정 없이 동작합니다.

## Demo Walkthrough

1. 루트 화면(`/`)의 챗봇 입력창에 요청을 입력합니다.
   ```text
   iOS 앱 개발 계획을 만들어줘
   ```
2. Orchestrator가 사용자 요청을 분석하고 필요한 Agent를 배정하는지 확인합니다.
3. 4분할 Agent panel에서 Orchestrator, Planner, Engineer, Reviewer의 상태와 메시지를 확인합니다.
4. 우측 상단 `Logs`에서 agent handoff, message event, approval event, error event를 필터링합니다.
5. 실행 중 입력창에 추가 지시를 보내 개입 메시지가 기록되는지 확인합니다.
6. 필요하면 `현재 작업 취소`로 active run을 중단합니다.
7. 완료 후 `산출물` 패널에서 Final Report, Messages timeline, Workspace 파일 preview를 확인합니다.
8. 좌측 session 목록에서 대화를 전환하거나 완료/중단된 대화를 삭제합니다.

## Architecture Overview

```text
Browser Chat UI
  ├─ ChatGPT형 session workspace
  ├─ 4분할 Agent panel
  ├─ Logs / Artifacts drawer
  └─ 사용자 개입 controls
        │
        ▼
Next.js API Routes
  ├─ POST /api/runs
  ├─ GET  /api/runs/:runId/events  (SSE)
  ├─ POST /api/runs/:runId/interventions
  ├─ POST /api/runs/:runId/approvals
  └─ GET  /api/runs/:runId/workspace
        │
        ▼
Agent Runtime
  ├─ Orchestrator: 요청 분석, Agent 배정, 최종 검증
  ├─ Planner: 요구사항/범위 정리
  ├─ Engineer: 구현/기술 산출물 작성
  └─ Reviewer: 보수적 품질 검토
        │
        ▼
Append-only Local Store
  ├─ .agentboard/runs/<runId>/events.jsonl
  ├─ .agentboard/runs/<runId>/messages.jsonl
  └─ .agentboard/workspaces/<runId>/
```

핵심 원칙:

- event log가 run의 source of truth입니다.
- Agent 간 메시지는 append-only record로 저장합니다.
- 사용자의 개입도 `user -> agent/all` structured message로 기록합니다.
- Orchestrator가 최종 사용자-facing 답변을 소유하고, Reviewer는 품질 gate 역할만 합니다.

자세한 설계는 [`docs/architecture.md`](docs/architecture.md)를 참고하세요.

## 주요 기능

- **ChatGPT형 시작 화면**: 처음부터 주제 선택 없이 채팅으로 시작합니다.
- **Session persistence**: 브라우저별 `clientSessionId`로 최근 대화를 복원합니다.
- **Agent panel**: Orchestrator, Planner, Engineer, Reviewer를 4분할로 관찰합니다.
- **Agent 확대 보기**: 각 Agent 창을 크게 열어 메시지와 승인 요청을 확인합니다.
- **Logs drawer**: Agent handoff, 권한 요청, 오류, tmux event를 필터링하고 raw payload를 봅니다.
- **User intervention**: 실행 중에도 추가 요청을 보내거나 작업을 취소할 수 있습니다.
- **Approval UI**: Codex 권한 prompt를 Web UI 승인/거절 카드로 표시합니다.
- **Auto approval allowlist**: `swift test`, `npm test` 같은 안전한 반복 검증 명령을 자동 승인할 수 있습니다.
- **Artifacts viewer**: Final Report, message timeline, workspace 파일 preview를 제공합니다.

## Optional: Real Codex + tmux Mode

실제 Codex를 사용하려면 해당 컴퓨터에 Codex CLI가 설치되어 있고 로그인이 완료되어 있어야 합니다. 제출/시연 기본 경로는 여전히 mock mode이며, real agent 실행은 선택 기능입니다.

```bash
cp .env.example .env.local
```

`.env.local`에서 최소한 아래처럼 설정합니다.

```env
AGENTBOARD_MODE=cli
AGENTBOARD_CODEX_CMD="codex --no-alt-screen"
AGENTBOARD_ORCHESTRATOR_ADAPTER=tmux-codex
AGENTBOARD_PLANNER_ADAPTER=tmux-codex
AGENTBOARD_ENGINEER_ADAPTER=tmux-codex
AGENTBOARD_REVIEWER_ADAPTER=tmux-codex
```

권장 tmux transport 설정:

```env
AGENTBOARD_TMUX_PROMPT_TRANSPORT=file-reference
AGENTBOARD_ORCHESTRATOR_TMUX_PROMPT_TRANSPORT=paste-buffer
```

- Planner/Engineer/Reviewer의 긴 prompt는 `file-reference`로 안정적으로 전달합니다.
- Orchestrator는 사용자 메시지를 빠르게 route해야 하므로 `paste-buffer`를 권장합니다.

반복 검증 명령 자동 승인 예시:

```env
AGENTBOARD_AUTO_APPROVE_COMMANDS=swift test,npm test,npm run typecheck
```

서버를 다시 실행합니다.

```bash
npm run dev
```

> `codex exec` 기반 one-shot adapter는 짧은 smoke 검증용 fallback입니다. 긴 작업, 권한 prompt, 완료 감지가 필요한 시연은 `tmux-codex`를 권장합니다.

## Configuration

핵심 환경변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AGENTBOARD_MODE` | `mock` | `mock` 또는 `cli` |
| `AGENTBOARD_CODEX_CMD` | `codex --no-alt-screen` | real Codex 실행 command |
| `AGENTBOARD_*_ADAPTER` | `tmux-codex` in cli mode | role별 adapter |
| `AGENTBOARD_TMUX_PROMPT_TRANSPORT` | `file-reference` | 긴 prompt 전달 방식 |
| `AGENTBOARD_ORCHESTRATOR_TMUX_PROMPT_TRANSPORT` | `paste-buffer` 권장 | Orchestrator 전용 빠른 handoff |
| `AGENTBOARD_AUTO_APPROVE_COMMANDS` | 없음 | 쉼표/줄바꿈 구분 command allowlist, `*` glob 지원 |

전체 설정은 [`docs/configuration.md`](docs/configuration.md)를 참고하세요. `.env.local`은 git에 올리지 않습니다.

## Test & QA

```bash
npm run typecheck
npm test
npm run build
```

Playwright QA:

```bash
npm run qa:e2e
```

Real adapter smoke는 로컬 Codex/tmux 설정이 있는 환경에서만 실행합니다.

```bash
npm run qa:cli-smoke
npm run qa:e2e:tmux
```

테스트 작성 규칙은 [`docs/test-writing-guide.md`](docs/test-writing-guide.md)를 참고하세요.

## Local State

실행 중 local runtime state가 생성됩니다.

```text
.agentboard/runs/<runId>/
.agentboard/runs/_sessions/<clientSessionId>.json
.agentboard/workspaces/<runId>/
```

`.agentboard/`, `.env.local`, build output, dependency folders는 `.gitignore` 대상입니다.

## API Surface

주요 API:

- `POST /api/runs` — run 생성
- `GET /api/sessions/:clientSessionId` — 브라우저 session 복원
- `GET /api/runs/:runId` — run state/messages/events 조회
- `GET /api/runs/:runId/events` — SSE event stream
- `POST /api/runs/:runId/interventions` — 진행 중 사용자 개입 또는 다음 요청
- `POST /api/runs/:runId/approvals` — Codex 권한 승인/거절
- `POST /api/runs/:runId/control` — stop/pause/resume
- `GET /api/runs/:runId/artifact` — final report 조회
- `GET /api/runs/:runId/workspace` — workspace 파일 목록 조회
- `GET /api/runs/:runId/workspace/file?path=...` — workspace 파일 preview
- `DELETE /api/runs/:runId` — 완료/중단 run 삭제

## Project Docs

- [`docs/architecture.md`](docs/architecture.md) — 전체 흐름과 모듈 구조
- [`docs/getting-started.md`](docs/getting-started.md) — 처음 사용하는 사람이 빠르게 실행하는 방법
- [`docs/configuration.md`](docs/configuration.md) — 설정값 설명 및 예시
- [`docs/test-writing-guide.md`](docs/test-writing-guide.md) — 테스트 작성 규칙과 예시
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — 자주 발생하는 문제와 해결 방법
- [`docs/extending.md`](docs/extending.md) — 기능 확장 방법 및 구조 설명

## Troubleshooting Quick Links

- Codex 권한 요청에서 멈춘 것처럼 보임 → [`docs/troubleshooting.md`](docs/troubleshooting.md)
- Engineer timeout / prompt submit 실패 → [`docs/troubleshooting.md`](docs/troubleshooting.md)
- workspace 산출물이 보이지 않음 → [`docs/troubleshooting.md`](docs/troubleshooting.md)
- real Codex 실행 환경변수 → [`docs/configuration.md`](docs/configuration.md)
