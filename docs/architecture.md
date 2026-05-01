# Architecture

## 목적

AgentBoard는 ChatGPT처럼 사용자가 메시지를 보내면 여러 AI 에이전트가 협업해 답변하고, 사용자가 채팅형 UI에서 그 과정을 관찰할 수 있게 만드는 로컬 실행형 MVP다.

핵심 증명은 다음 세 가지다.

1. 두 개 이상의 에이전트가 구조화된 메시지를 주고받는다.
2. 사용자는 Chat UI에서 에이전트 상태, 메시지, 산출물을 실시간으로 관찰한다.
3. 사용자는 답변 생성 중에도 추가 지시를 보내고, Orchestrator가 이를 현재 flow에 반영할지 판단한다.

## 전체 흐름

```text
사용자
  └─ Browser Chat UI
      ├─ 첫 메시지로 대화 생성
      ├─ 좌측 session 목록으로 최근 대화 복원
      ├─ 4분할 Agent 채팅 패널로 상태/대화 관찰
      ├─ 사용자-facing 메시지 버블 관찰
      ├─ 각 Agent 패널에서 권한 요청 승인/거절
      ├─ Logs drawer로 agent handoff와 raw event 관찰
      ├─ 좌측 session 목록에서 완료/중단 run 삭제
      ├─ 답변 생성 중 개입 입력과 취소 버튼
      └─ 보고서 drawer 확인

Next.js App
  ├─ Page / React Components
  ├─ API Route Handlers
  ├─ SSE Event Stream
  ├─ Browser session resume lookup
  └─ Runner Launcher

Runner Process
  ├─ Agent Definition Registry
  ├─ Agent Managers
  ├─ Orchestrator Strategy
  ├─ Prompt Builder
  ├─ Agent Session Runtime
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

- `ChatWorkspace`: 루트(`/`)의 ChatGPT형 shell. 좌측 세션 목록, 새 대화 버튼, 실행 모드 선택, 빈 챗봇 composer, 선택 run embedding을 제공한다.
- `ChatRoom`: run header, 진행 indicator, 4분할 agent chat panel, 권한 승인 카드, agent handoff Logs drawer와 log detail modal, 보고서 drawer, 사용자 요청 composer와 취소 컨트롤을 한 화면에서 제공한다. `/runs/:runId` 단독 페이지와 `ChatWorkspace` embedded 모드에서 함께 사용한다.
- `ChatRoom`의 selected agent/log/report/draft 같은 가벼운 UI 상태는 run별 localStorage key에 저장한다.

브라우저 session state는 두 계층으로 나뉜다.

- 서버 local file store: `clientSessionId`와 active/recent run association
- 브라우저 `localStorage`: run별 선택 agent, Logs/보고서 drawer, draft 같은 UI 편의 상태

### Next.js API Layer

Chat UI와 Runner 사이의 HTTP 경계다.

주요 책임:

- Run 생성
- Run 삭제
- Session snapshot 조회 및 stale run 정리
- Run 상태 조회
- SSE event stream 제공
- 사용자 요청 메시지 기록 및 새 답변 turn 시작
- 진행 중 사용자 개입을 queue로 저장하고 Orchestrator 판단 checkpoint에 노출
- pause/resume/stop 같은 제어 명령 전달. UI 취소는 `stop` 사용

### Runner Process

실제 에이전트 협업을 진행하는 실행 루프다. AgentBoard가 session context를 소유하고, adapter 출력은 그 context에 저장되는 실행 결과로만 취급한다.

주요 책임:

- Run 초기화
- Agent manager 생성
- Agent definition 조회
- 최신 사용자 요청 turn 식별
- 실행 중 새로 들어온 사용자 개입 식별
- `messages.jsonl` 기반 visible conversation과 agent handoff context 구성
- Orchestrator Agent가 이번 turn의 실행 계획 JSON 생성
- Agent step 사이와 verify 직전 checkpoint에서 Orchestrator가 개입을 `continue`, `restart`, `ask_user` 중 하나로 판단
- Agent별 prompt 조립과 adapter 호출
- Agent 간 메시지 라우팅
- 완료/중단 run 삭제 시 local state와 client session index 정리
- 제어 명령에 따른 runner 정지
- Event log 기록
- 최종 artifact 작성

### Agent Managers

OpenCode의 `create-managers.ts`처럼 runtime이 직접 전역 객체를 붙잡지 않도록 협업 실행에 필요한 의존성을 한 번에 조립한다.

현재 manager 구성:

- `agentRegistry`: role별 `AgentDefinition` 조회
- `promptBuilder`: `AgentDefinition`과 session context를 실제 adapter prompt로 변환
- `messageBus`: Agent-to-Agent, Agent-to-User 메시지 저장
- `orchestratorStrategy`: Orchestrator가 없거나 JSON parsing에 실패했을 때 사용할 fallback 순서 결정

MVP에서는 lightweight factory인 `createAgentManagers()`를 사용한다. 이후 background session, tmux pane, approval gate 같은 기능을 붙일 때도 Runtime 자체보다 manager 구성을 확장한다.

### Orchestrator Strategy

오케스트레이터는 먼저 사용자 요청을 분석해 필요한 Agent와 업무를 JSON plan으로 만든다. 기본 fallback strategy는 Orchestrator가 비활성화되었거나 출력 JSON을 파싱할 수 없을 때만 사용한다.

fallback strategy:

```text
enabled agents ∩ [planner, engineer, reviewer]
```

정상 흐름에서는 Orchestrator plan이 다음을 결정한다.

- Engineer 결과를 Orchestrator가 바로 최종화
- Reviewer 품질 검토 gate 추가
- Planner 생략 후 Engineer 직접 응답
- Researcher 같은 신규 Agent 삽입
- 사용자 승인 gate 이후 다음 Agent 실행

### Agent Session Runtime

OpenCode의 session runtime처럼 AgentBoard 내부가 대화 이력을 유지하고 각 Agent 호출에 context를 주입한다. 다만 과제 증명을 위해 Agent 간 handoff는 명시적인 `AgentMessage`로 남긴다.

원칙:

- Codex CLI stdout은 직접 Agent 간 통신 채널이 아니라 adapter 실행 결과다.
- Runtime은 최신 `user_intervention` 이후의 Agent handoff만 이번 turn context로 본다.
- Runtime은 Orchestrator plan의 `steps`에 있는 Agent만 순서대로 실행한다.
- `finalResponder`는 사용자-facing 작성자가 아니라 Orchestrator가 검증할 후보 결과를 마지막으로 제공하는 Agent다. 최종 사용자 답변은 `orchestrator -> user` result로 저장한다.

### Message Bus

에이전트와 사용자의 모든 메시지를 같은 구조로 다룬다.

원칙:

- 메시지는 append-only로 저장한다.
- `messages.jsonl`이 메시지 이력의 기준이다.
- 각 recipient inbox는 라우팅과 디버깅을 위한 파생 로그다.
- 사용자 요청은 `from: "user"`, `kind: "user_intervention"` 메시지로 저장한다.
- 답변 생성 중 사용자 요청도 `user_intervention`으로 저장하며, 즉시 새 runner를 띄우지 않고 현재 runner의 Orchestrator checkpoint에서 처리한다.

### Agent Adapters

에이전트 실행 방식을 숨기는 경계다.

지원 대상:

- `MockAgentAdapter`: README 기본 데모. 외부 key 없이 deterministic하게 동작한다.
- `CliAgentAdapter`: optional. 로컬 `codex` CLI를 `shell: false`로 실행하고 stdout을 runtime에 반환한다. Runtime이 stdout을 Agent message로 저장하고 다음 Agent prompt context에 주입한다.
- `TmuxSessionAdapter`: optional. role별 persistent tmux session에 Codex를 유지하고, prompt마다 AgentBoard transport marker를 요구한다. 긴 prompt는 `.agentboard/runs/<runId>/tmux-prompts/` 임시 파일을 통해 `tmux load-buffer`로 주입한 뒤 삭제한다. `capture-pane` polling으로 `AGENTBOARD_DONE` marker를 감지하면 `session.completed` 이벤트를 남기고 marker를 제거한 output만 Runtime에 반환한다. DONE marker가 누락되어도 `AGENTBOARD_BEGIN` 이후 output이 있고 Codex가 idle prompt로 복귀한 뒤 같은 output이 `AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS` 동안 안정적으로 유지되어야 `completionSource=idle-prompt-fallback`으로 완료 처리한다. Codex 권한 프롬프트는 `approval.requested` event로 승격하고 Web UI 승인/거절을 `POST /api/runs/:runId/approvals`를 통해 다시 tmux pane에 주입한다.
- Firebase/Cloud adapter: optional future work. MVP 기본 경로를 깨면 안 된다.

CLI mode 기본 role 매핑:

| Role | 기본 adapter | command env |
| --- | --- | --- |
| `orchestrator` | `codex` | `AGENTBOARD_CODEX_CMD` |
| `planner` | `codex` | `AGENTBOARD_CODEX_CMD` |
| `engineer` | `codex` | `AGENTBOARD_CODEX_CMD` |
| `reviewer` | `codex` | `AGENTBOARD_CODEX_CMD` |

## Runtime sequence

### 1. Run 생성

```text
Browser ChatWorkspace -> POST /api/runs -> Next.js API -> run directory 생성 -> runner 시작 -> workspace에서 run 선택
```

1. 사용자가 `/`의 빈 챗봇 composer에 첫 메시지를 입력한다.
2. `POST /api/runs`가 `run.json`, `state.json`을 만든다.
3. 요청에 `clientSessionId`가 있으면 `_sessions/<clientSessionId>.json`의 active/recent run을 갱신한다.
4. 서버가 mock runner를 기본 실행한다.
5. ChatWorkspace가 새 run을 선택하고 좌측 세션 목록을 갱신한다.
6. Embedded ChatRoom이 `GET /api/runs/<runId>/events`에 `EventSource`로 연결한다.

### 1-1. Session resume

```text
Browser localStorage clientSessionId -> GET /api/sessions/<clientSessionId> -> 좌측 active/recent run 표시 -> run 선택
```

1. 브라우저가 `clientSessionId`를 localStorage에서 읽거나 새로 만든다.
2. ChatWorkspace가 session snapshot을 조회한다.
3. 서버는 missing run을 recent list에서 제거하고, 오래된 `running` run을 `stale`로 표시한다.
4. UI는 active run 또는 recent run을 좌측 세션 목록에 보여준다.
5. active run이 있으면 자동 선택하고, 없으면 가장 최근 run을 선택한다.


### 1-2. ChatRoom session active 연결

```text
/runs/<runId> open -> localStorage clientSessionId 확인 -> POST /api/sessions/<clientSessionId>/active-run -> _sessions index 갱신
```

이 route는 사용자가 좌측 세션 목록이 아닌 직접 URL로 채팅방에 들어온 경우에도 현재 브라우저 session의 active run을 최신화하기 위한 보조 API다. `clientSessionId`는 인증 토큰이 아니라 로컬 resume 편의를 위한 association key다.

### 2. Agent 간 협업

```text
User request -> Agent Session Runtime -> Orchestrator -> Message Bus assignments -> selected Agents -> Orchestrator verification -> User answer + Artifact
```

1. Runtime이 최신 사용자 요청과 최근 user-facing 대화를 context로 만든다.
2. Orchestrator Agent가 필요한 Agent 실행 계획 JSON을 만든다.
3. Runtime이 Orchestrator plan을 파싱하고, 각 step을 `orchestrator -> agent` `instruction` 메시지로 저장한다.
4. Prompt Builder가 Agent별 system prompt, 최신 사용자 요청, visible conversation, handoff context, Orchestrator assignment를 조립한다.
5. 선택된 Agent들이 plan 순서대로 실행되고 필요한 경우 다음 Agent에게 handoff 메시지를 남긴다.
6. Agent step이 끝날 때 또는 verify 직전 새 사용자 개입이 있으면 Orchestrator가 `continue`, `restart`, `ask_user` 중 하나를 결정한다.
7. `finalResponder` 출력은 `finalResponder -> orchestrator` 후보 결과 또는 검토 로그로 저장되고, 최종 사용자 답변은 Orchestrator 검증 뒤 `orchestrator -> user` `result`로 저장된다.
8. Runner가 `artifacts/final-report.md`를 갱신한다.

### 2-1. 진행 중 사용자 개입

```text
Browser -> POST /api/runs/<runId>/interventions -> user_intervention 저장 -> 현재 Agent step 완료 -> Orchestrator decision -> continue/restart/ask_user
```

- `continue`: 현재 flow를 유지하고 다음 Agent prompt에 추가 지시를 전달한다.
- `restart`: 같은 run 안에서 기존 partial log를 남기고 Orchestrator plan을 다시 만든다.
- `ask_user`: run을 `paused`로 바꾸고 Orchestrator가 사용자에게 확인 질문을 보낸다. 사용자가 답하면 같은 API가 run을 다시 `running`으로 바꾸고 runner를 재시작한다.

### 3. 사용자 요청 turn

```text
Browser -> POST /api/runs/<runId>/interventions -> user message 저장 -> Runner 시작 -> Orchestrator 최종 답변 -> ChatRoom refresh
```

1. 사용자가 ChatRoom composer에서 다음 요청을 보낸다.
2. API가 `user_intervention` 메시지를 저장하고 run status를 `running`으로 바꾼다.
3. Runner가 Orchestrator plan에 따라 필요한 Agent만 실행한 뒤 Orchestrator → User 답변 메시지를 생성한다.
4. 답변 생성 중에도 composer는 활성화되어 `개입 보내기`와 `현재 작업 취소` 버튼을 보여준다.
5. 사용자가 `취소`를 누르면 control API가 runner를 정지하고 run status를 `stopped`로 바꾼다. 완료 또는 중단 뒤에는 같은 composer에서 다음 요청을 다시 보낼 수 있다.

## Event log 기준

`events.jsonl`은 run에서 발생한 사실의 audit trail이다.

대표 event type:

- `run.created`
- `run.started`
- `agent.started`
- `agent.status_changed`
- `message.sent`
- `message.delivered`
- `user.intervention_queued`
- `intervention.decision_made`
- `session.created`
- `session.prompt_injected`
- `session.output_captured`
- `session.completed`
- `session.completion_timeout`
- `approval.requested`
- `approval.approved`
- `approval.rejected`
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
- `POST /api/runs/:runId/interventions` — 새 사용자 요청 turn 시작
- `POST /api/runs/:runId/control` — UI 취소는 `stop` 사용
- `POST /api/runs/:runId/approvals` — tmux Codex 권한 요청 승인/거절
- `DELETE /api/runs/:runId` — 진행 중이 아닌 run hard delete

## ASAP 구현 순서

일자별 계획이 아니라 작동하는 vertical slice 기준으로 진행한다.

1. Protocol type 정의
2. JSONL store 작성
3. Run 생성 API
4. Mock runner와 Message Bus
5. SSE 기반 ChatRoom transcript와 Logs drawer
6. Agent 상태 rail
7. 사용자 요청 composer, 진행 indicator, 취소 컨트롤
8. 보고서 drawer
9. Browser session resume와 ChatRoom UI state persistence
10. README 실행 흐름
11. Optional Firebase/CLI adapter

## 설계 제약

- Mock mode는 항상 외부 key 없이 실행 가능해야 한다.
- Firebase는 optional이어야 하며 local file-backed mode를 대체하지 않는다.
- CLI adapter는 allowlist 기반으로 실행하고 shell 문자열 조합을 피한다.
- 실제 secret은 `.env.local`이나 ignored local config에만 둔다.
- `.agentboard/runs/`와 Xcode/Swift `DerivedData`, `.noindex`, `xcuserdata`는 생성 상태이므로 commit하지 않는다.
