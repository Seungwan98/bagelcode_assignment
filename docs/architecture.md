# Architecture

## 목적

AgentBoard는 여러 AI 에이전트가 하나의 작업을 분담하고, 사용자가 Web Dashboard에서 협업 과정을 관찰·개입할 수 있게 만드는 로컬 실행형 MVP다.

핵심 증명은 다음 세 가지다.

1. 두 개 이상의 에이전트가 구조화된 메시지를 주고받는다.
2. 사용자는 Dashboard에서 에이전트 상태, 메시지, 산출물을 실시간으로 관찰한다.
3. 사용자는 실행 중 특정 에이전트 또는 전체 팀에 지시를 추가할 수 있다.

## 전체 흐름

```text
사용자
  └─ Browser Dashboard
      ├─ Run 생성
      ├─ Agent 상태 관찰
      ├─ Event Timeline 관찰
      ├─ User Intervention 전송
      └─ Artifact 확인

Next.js App
  ├─ Page / React Components
  ├─ API Route Handlers
  ├─ SSE Event Stream
  └─ Runner Launcher

Runner Process
  ├─ Message Bus
  ├─ Agent Adapters
  ├─ Event Writer
  ├─ Artifact Writer
  └─ Control Loop

Local State Store
  └─ .agentboard/runs/<runId>/
      ├─ run.json
      ├─ state.json
      ├─ events.jsonl
      ├─ messages.jsonl
      ├─ agents/<agentId>/inbox.jsonl
      ├─ agents/user/inbox.jsonl
      └─ artifacts/final-report.md
```

## 모듈 구조

### Browser Dashboard

사용자가 직접 보는 UI다.

주요 구성:

- `RunCreateForm`: 과제 입력과 실행 모드 선택
- `/runs/<runId>` page header: run 제목, 상태, 새 run 링크
- `AgentCardList`: 에이전트별 역할/상태/마지막 메시지
- `EventTimeline`: SSE로 수신한 이벤트 표시
- `InterventionComposer`: 사용자 지시 입력
- `ArtifactPanel`: 최종 Markdown 산출물 표시

### Next.js API Layer

Dashboard와 Runner 사이의 HTTP 경계다.

주요 책임:

- Run 생성
- Run 상태 조회
- SSE event stream 제공
- 사용자 개입 메시지 기록
- pause/resume/stop 같은 제어 명령 전달

### Runner Process

실제 에이전트 협업을 진행하는 실행 루프다.

주요 책임:

- Run 초기화
- Agent adapter 시작/정지
- Agent 간 메시지 라우팅
- 사용자 개입 메시지 전달
- Event log 기록
- 최종 artifact 작성

### Message Bus

에이전트와 사용자의 모든 메시지를 같은 구조로 다룬다.

원칙:

- 메시지는 append-only로 저장한다.
- `messages.jsonl`이 메시지 이력의 기준이다.
- 각 recipient inbox는 라우팅과 디버깅을 위한 파생 로그다.
- 사용자 개입도 `from: "user"`인 메시지로 저장한다.

### Agent Adapters

에이전트 실행 방식을 숨기는 경계다.

지원 대상:

- `MockAgentAdapter`: README 기본 데모. 외부 key 없이 deterministic하게 동작한다.
- `CliAgentAdapter`: optional. 로컬 `codex`, `claude`, `gemini` CLI를 `shell: false`로 실행하고 stdout을 agent message로 저장한다.
- Firebase/Cloud adapter: optional future work. MVP 기본 경로를 깨면 안 된다.

CLI mode 기본 role 매핑:

| Role | 기본 adapter | command env |
| --- | --- | --- |
| `planner` | `codex` | `AGENTBOARD_CODEX_CMD` |
| `engineer` | `claude` | `AGENTBOARD_CLAUDE_CMD` |
| `reviewer` | `gemini` | `AGENTBOARD_GEMINI_CMD` |

## Runtime sequence

### 1. Run 생성

```text
Browser -> POST /api/runs -> Next.js API -> run directory 생성 -> runner 시작 -> Browser /runs/<runId> 이동
```

1. 사용자가 `/`에서 과제 brief를 입력한다.
2. `POST /api/runs`가 `run.json`, `state.json`을 만든다.
3. 서버가 mock runner를 기본 실행한다.
4. Dashboard가 `/runs/<runId>`로 이동한다.
5. Browser가 `GET /api/runs/<runId>/events`에 `EventSource`로 연결한다.

### 2. Agent 간 협업

```text
Planner -> Message Bus -> Engineer -> Message Bus -> Reviewer -> Artifact
```

1. Planner가 Engineer에게 `instruction` 메시지를 보낸다.
2. Message Bus가 `messages.jsonl`과 Engineer inbox에 기록한다.
3. Engineer가 `progress`, `result` 메시지를 보낸다.
4. Reviewer가 결과를 검토한다.
5. Runner가 `artifacts/final-report.md`를 갱신한다.

### 3. 사용자 개입

```text
Browser -> POST /api/runs/<runId>/interventions -> Message Bus -> Agent inbox -> Agent response -> Timeline
```

1. 사용자가 Dashboard에서 지시를 입력한다.
2. API가 `user_intervention` 메시지를 생성한다.
3. Message Bus가 대상 agent 또는 `all`에게 라우팅한다.
4. Agent가 지시를 ack하고 후속 결과에 반영한다.
5. Timeline과 artifact가 갱신된다.

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
- `error`

`state.json`은 UI 속도를 위한 snapshot이며, 필요하면 event log에서 재구성할 수 있어야 한다.

## API 요약

상세 스펙은 `configuration.md`와 구현 코드의 route handler를 기준으로 한다.

- `POST /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/interventions`
- `POST /api/runs/:runId/control`

## ASAP 구현 순서

일자별 계획이 아니라 작동하는 vertical slice 기준으로 진행한다.

1. Protocol type 정의
2. JSONL store 작성
3. Run 생성 API
4. Mock runner와 Message Bus
5. SSE Timeline
6. Agent 상태 카드
7. User Intervention API/UI
8. Artifact Panel
9. README 실행 흐름
10. Optional Firebase/CLI adapter

## 설계 제약

- Mock mode는 항상 외부 key 없이 실행 가능해야 한다.
- Firebase는 optional이어야 하며 local file-backed mode를 대체하지 않는다.
- CLI adapter는 allowlist 기반으로 실행하고 shell 문자열 조합을 피한다.
- 실제 secret은 `.env.local`이나 ignored local config에만 둔다.
- `.agentboard/runs/`는 생성 상태이므로 commit하지 않는다.
