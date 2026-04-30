# Architecture

## 목적

AgentBoard는 첫 메시지로 여러 AI 에이전트 작업을 시작하고, 사용자가 채팅형 UI에서 협업 과정을 관찰하며 진행 중 취소로 흐름을 제어할 수 있게 만드는 로컬 실행형 MVP다.

핵심 증명은 다음 세 가지다.

1. 두 개 이상의 에이전트가 구조화된 메시지를 주고받는다.
2. 사용자는 Chat UI에서 에이전트 상태, 메시지, 산출물을 실시간으로 관찰한다.
3. 사용자는 실행 중 추가 전송 없이 진행 상태를 확인하고 필요하면 run을 취소할 수 있다.

## 전체 흐름

```text
사용자
  └─ Browser Chat UI
      ├─ 첫 메시지로 대화 생성
      ├─ session resume 카드로 최근 대화 복원
      ├─ Agent 상태 rail 관찰
      ├─ Agent detail panel로 현재 상태 확인
      ├─ 사용자-facing 메시지 버블 관찰
      ├─ Logs drawer로 agent handoff 관찰
      ├─ 진행 중 composer 잠금과 취소 버튼
      └─ 보고서 drawer 확인

Next.js App
  ├─ Page / React Components
  ├─ API Route Handlers
  ├─ SSE Event Stream
  ├─ Browser session resume lookup
  └─ Runner Launcher

Runner Process
  ├─ Message Bus
  ├─ Agent Adapters
  ├─ Event Writer
  ├─ Artifact Writer
  └─ Control Loop

Local State Store
  ├─ .agentboard/runs/<runId>/
      ├─ run.json
      ├─ state.json
      ├─ events.jsonl
      ├─ messages.jsonl
      ├─ agents/<agentId>/inbox.jsonl
      ├─ agents/user/inbox.jsonl
      └─ artifacts/final-report.md
  └─ .agentboard/runs/_sessions/<clientSessionId>.json
```

## 모듈 구조

### Browser Chat UI

사용자가 직접 보는 UI다.

주요 구성:

- `RunCreateForm`: 첫 요청 composer, 실행 모드 선택, 브라우저 session 생성/조회, 최근 run resume 카드
- `ChatRoom`: run header, 진행 indicator, agent rail, 선택 agent detail panel, user-facing 메시지 transcript, agent handoff Logs drawer와 log detail modal, 보고서 drawer, 취소 컨트롤을 한 화면에서 제공
- `ChatRoom`의 selected agent/log/report 같은 가벼운 UI 상태는 run별 localStorage key에 저장한다.

브라우저 session state는 두 계층으로 나뉜다.

- 서버 local file store: `clientSessionId`와 active/recent run association
- 브라우저 `localStorage`: run별 선택 agent, Logs/보고서 drawer 같은 UI 편의 상태

### Next.js API Layer

Chat UI와 Runner 사이의 HTTP 경계다.

주요 책임:

- Run 생성
- Session snapshot 조회 및 stale run 정리
- Run 상태 조회
- SSE event stream 제공
- 호환용 사용자 개입 메시지 기록
- pause/resume/stop 같은 제어 명령 전달. UI 취소는 `stop` 사용

### Runner Process

실제 에이전트 협업을 진행하는 실행 루프다.

주요 책임:

- Run 초기화
- Agent adapter 시작/정지
- Agent 간 메시지 라우팅
- 제어 명령에 따른 runner 정지
- Event log 기록
- 최종 artifact 작성

### Message Bus

에이전트와 사용자의 모든 메시지를 같은 구조로 다룬다.

원칙:

- 메시지는 append-only로 저장한다.
- `messages.jsonl`이 메시지 이력의 기준이다.
- 각 recipient inbox는 라우팅과 디버깅을 위한 파생 로그다.
- 호환용 사용자 개입 API는 `from: "user"`인 메시지로 저장하지만, 기본 UI는 진행 중 추가 전송을 막는다.

### Agent Adapters

에이전트 실행 방식을 숨기는 경계다.

지원 대상:

- `MockAgentAdapter`: README 기본 데모. 외부 key 없이 deterministic하게 동작한다.
- `CliAgentAdapter`: optional. 로컬 `codex` CLI를 `shell: false`로 실행하고 stdout을 agent message로 저장한다.
- Firebase/Cloud adapter: optional future work. MVP 기본 경로를 깨면 안 된다.

CLI mode 기본 role 매핑:

| Role | 기본 adapter | command env |
| --- | --- | --- |
| `planner` | `codex` | `AGENTBOARD_CODEX_CMD` |
| `engineer` | `codex` | `AGENTBOARD_CODEX_CMD` |
| `reviewer` | `codex` | `AGENTBOARD_CODEX_CMD` |

## Runtime sequence

### 1. Run 생성

```text
Browser -> POST /api/runs -> Next.js API -> run directory 생성 -> runner 시작 -> Browser /runs/<runId> 이동
```

1. 사용자가 `/`에서 과제 brief를 입력한다.
2. `POST /api/runs`가 `run.json`, `state.json`을 만든다.
3. 요청에 `clientSessionId`가 있으면 `_sessions/<clientSessionId>.json`의 active/recent run을 갱신한다.
4. 서버가 mock runner를 기본 실행한다.
5. Chat UI가 `/runs/<runId>`로 이동한다.
6. Browser가 `GET /api/runs/<runId>/events`에 `EventSource`로 연결한다.

### 1-1. Session resume

```text
Browser localStorage clientSessionId -> GET /api/sessions/<clientSessionId> -> active/recent run 표시 -> /runs/<runId> 이동
```

1. 브라우저가 `clientSessionId`를 localStorage에서 읽거나 새로 만든다.
2. Landing UI가 session snapshot을 조회한다.
3. 서버는 missing run을 recent list에서 제거하고, 오래된 `running` run을 `stale`로 표시한다.
4. UI는 active run 또는 recent run을 resume 카드로 보여준다.


### 1-2. ChatRoom session active 연결

```text
/runs/<runId> open -> localStorage clientSessionId 확인 -> POST /api/sessions/<clientSessionId>/active-run -> _sessions index 갱신
```

이 route는 사용자가 resume 카드가 아닌 직접 URL로 채팅방에 들어온 경우에도 현재 브라우저 session의 active run을 최신화하기 위한 보조 API다. `clientSessionId`는 인증 토큰이 아니라 로컬 resume 편의를 위한 association key다.

### 2. Agent 간 협업

```text
Planner -> Message Bus -> Engineer -> Message Bus -> Reviewer -> Artifact
```

1. Planner가 Engineer에게 `instruction` 메시지를 보낸다.
2. Message Bus가 `messages.jsonl`과 Engineer inbox에 기록한다.
3. Engineer가 `progress`, `result` 메시지를 보낸다.
4. Reviewer가 결과를 검토한다.
5. Runner가 `artifacts/final-report.md`를 갱신한다.

### 3. 진행 중 사용자 제어

```text
Browser -> POST /api/runs/<runId>/control { action: "stop" } -> Runner stop -> control.stopped event -> ChatRoom refresh
```

1. ChatRoom은 `created`, `running`, `paused` 상태를 진행 중으로 본다.
2. 진행 중에는 하단 입력창을 disabled 처리하고 현재 작업 indicator를 보여준다.
3. 사용자가 `취소`를 누르면 control API가 mock/CLI runner를 정지하고 run status를 `stopped`로 바꾼다.
4. 완료·실패·중단 뒤 새 요청은 루트의 첫 메시지 composer에서 새 run으로 시작한다.
5. `POST /api/runs/:runId/interventions`는 기존 테스트와 API 호환을 위해 남기지만 기본 UI 경로에서는 노출하지 않는다.

## Event log 기준

`events.jsonl`은 run에서 발생한 사실의 audit trail이다.

대표 event type:

- `run.created`
- `run.started`
- `agent.started`
- `agent.status_changed`
- `message.sent`
- `message.delivered`
- `user.intervened`
- `artifact.updated`
- `run.completed`
- `run.stale`
- `error`

`state.json`은 UI 속도를 위한 snapshot이며, 필요하면 event log에서 재구성할 수 있어야 한다.

## API 요약

상세 스펙은 `configuration.md`와 구현 코드의 route handler를 기준으로 한다.

- `POST /api/runs`
- `GET /api/sessions/:clientSessionId`
- `POST /api/sessions/:clientSessionId/active-run`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/interventions` — 호환용
- `POST /api/runs/:runId/control` — UI 취소는 `stop` 사용

## ASAP 구현 순서

일자별 계획이 아니라 작동하는 vertical slice 기준으로 진행한다.

1. Protocol type 정의
2. JSONL store 작성
3. Run 생성 API
4. Mock runner와 Message Bus
5. SSE 기반 ChatRoom transcript와 Logs drawer
6. Agent 상태 rail
7. 진행 indicator와 취소 컨트롤
8. 보고서 drawer
9. Browser session resume와 ChatRoom UI state persistence
10. README 실행 흐름
11. Optional Firebase/CLI adapter

## 설계 제약

- Mock mode는 항상 외부 key 없이 실행 가능해야 한다.
- Firebase는 optional이어야 하며 local file-backed mode를 대체하지 않는다.
- CLI adapter는 allowlist 기반으로 실행하고 shell 문자열 조합을 피한다.
- 실제 secret은 `.env.local`이나 ignored local config에만 둔다.
- `.agentboard/runs/`는 생성 상태이므로 commit하지 않는다.
