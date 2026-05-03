# Web Dashboard MVP Plan & Technical Specification

## 0. One-line concept

**AgentBoard**: 사용자가 Web Dashboard에서 과제를 입력하면 Planner/Engineer/Reviewer 같은 여러 AI 에이전트가 메시지를 주고받고, 사용자는 실시간 타임라인을 관찰하거나 중간 지시를 삽입할 수 있는 로컬 실행형 멀티 에이전트 협업 도구.

## 1. MVP goal

과제 제출 관점에서 가장 중요한 증명은 다음 3가지다.

1. **2개 이상 에이전트가 서로 메시지를 주고받는다.**
2. **사용자가 협업 과정을 관찰할 수 있다.**
3. **사용자가 중간에 개입해 에이전트 흐름에 영향을 줄 수 있다.**

따라서 MVP는 거대한 자동화 플랫폼이 아니라, `README대로 실행 -> Dashboard 접속 -> 데모 Run 시작 -> Agent 간 메시지 관찰 -> 사용자 지시 삽입 -> 최종 Artifact 확인` 흐름을 완성하는 데 집중한다.

## 2. Scope

### Must-have

- Workspace/Run 생성 화면
- 최소 2개 Agent 실행: `Planner`, `Engineer`
- Agent 간 메시지 라우팅
- 실시간 Event Timeline
- Agent 상태 카드
- 사용자 개입 입력창: 특정 agent 또는 전체 team에게 instruction 전송
- Artifact 패널: 최종 Markdown 결과 확인
- Mock agent mode: API key나 CLI 설치 없이 README 데모 가능
- Optional real CLI mode: `codex`, `claude`, `gemini` adapter 구조 제공

### Nice-to-have

- Reviewer agent 추가
- Pause/resume/stop control
- Approval gate
- 메시지 graph/matrix view
- Run export zip/markdown

### Explicit non-goals for MVP

- 로그인/권한 관리
- 멀티 유저 협업
- 클라우드 배포 안정화
- 완전한 sandboxing
- 장기 실행 production job queue

## 3. Recommended stack

### Primary stack

- **Next.js App Router + TypeScript**: Dashboard UI, API Route Handlers, local dev server
- **React client components**: Timeline, Agent cards, intervention composer
- **Server-Sent Events (SSE)**: server -> browser 실시간 event stream
- **File-based JSONL store**: `.agentboard/runs/<runId>/events.jsonl`, `messages.jsonl`, `state.json`
- **Node.js child_process.spawn**: optional CLI agent adapter 실행
- **Tailwind CSS**: 빠른 UI 구현
- **Vitest or Node test runner**: protocol/router unit test
- **Playwright optional**: README demo e2e smoke test

### Why SSE over WebSocket for MVP

- Dashboard는 대부분 server -> browser 이벤트 구독이 핵심이다.
- 사용자의 개입은 별도 POST API로 충분하다.
- WebSocket room/session 관리보다 구현이 작고 README 재현성이 좋다.

### Why JSONL file store over DB for MVP

- 설치가 단순하다.
- Agent CLI가 파일을 읽고 쓰기 쉽다.
- 평가자가 로그를 직접 열어 evidence를 확인할 수 있다.
- v2에서 SQLite/Postgres로 교체 가능하다.

## 4. High-level architecture

```text
Browser Dashboard
  ├─ Run creation form
  ├─ Agent status cards
  ├─ Event timeline via EventSource
  ├─ Message/intervention composer
  └─ Artifact viewer

Next.js App
  ├─ API Route Handlers
  │   ├─ POST /api/runs
  │   ├─ GET  /api/runs/:runId
  │   ├─ GET  /api/runs/:runId/events
  │   ├─ POST /api/runs/:runId/interventions
  │   └─ POST /api/runs/:runId/control
  └─ Runner launcher

Agent Runner Process
  ├─ Task planner
  ├─ Message bus
  ├─ Agent adapters
  │   ├─ MockAgentAdapter
  │   ├─ CodexCliAdapter optional
  │   ├─ ClaudeCliAdapter optional
  │   └─ GeminiCliAdapter optional
  ├─ Event writer
  └─ Artifact writer

.agentboard/runs/<runId>/
  ├─ run.json
  ├─ state.json
  ├─ events.jsonl
  ├─ messages.jsonl
  ├─ user-inbox.jsonl
  ├─ agents/<agentId>/inbox.jsonl
  ├─ agents/<agentId>/outbox.jsonl
  └─ artifacts/final-report.md
```

## 5. Runtime flow

### 5.1 Run start

1. User enters assignment brief in dashboard.
2. Browser calls `POST /api/runs`.
3. Server creates `.agentboard/runs/<runId>/`.
4. Server spawns runner process:
   - mock mode: `node dist/runner.js --mode mock --run-id <id>`
   - cli mode: `node dist/runner.js --mode cli --run-id <id>`
5. Dashboard navigates to `/runs/<runId>`.
6. Browser opens `EventSource('/api/runs/<runId>/events')`.

### 5.2 Agent collaboration

1. Runner creates task: `Draft tool plan`.
2. Planner emits message to Engineer:
   - `kind=instruction`
   - `body="Web Dashboard architecture 초안 작성해줘"`
3. Message bus writes message to `messages.jsonl` and target inbox.
4. Engineer reads inbox, emits progress/result.
5. Planner reviews Engineer result.
6. Final artifact is written to `artifacts/final-report.md`.

### 5.3 User intervention

1. User types instruction in dashboard: “CLI adapter는 optional로 두고 mock mode를 기본으로 해.”
2. Browser calls `POST /api/runs/<runId>/interventions`.
3. Server appends event and writes to target agent inbox.
4. Runner delivers it to active agent.
5. Dashboard timeline shows `user.intervened` and subsequent agent response.

## 6. Data model

### 6.1 Run

```ts
type RunStatus = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

interface Run {
  id: string;
  title: string;
  brief: string;
  status: RunStatus;
  mode: 'mock' | 'cli';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

### 6.2 Agent

```ts
type AgentRole = 'planner' | 'engineer' | 'reviewer';
type AgentStatus = 'idle' | 'thinking' | 'waiting' | 'blocked' | 'done' | 'failed';

interface AgentState {
  id: string;
  role: AgentRole;
  displayName: string;
  adapter: 'mock' | 'codex' | 'claude' | 'gemini';
  status: AgentStatus;
  currentTaskId?: string;
  lastMessageAt?: string;
}
```

### 6.3 Message

```ts
type MessageKind =
  | 'instruction'
  | 'question'
  | 'answer'
  | 'progress'
  | 'result'
  | 'review'
  | 'user_intervention'
  | 'ack'
  | 'error';

interface AgentMessage {
  id: string;
  runId: string;
  from: string; // agentId or 'user' or 'system'
  to: string;   // agentId or 'all'
  kind: MessageKind;
  body: string;
  correlationId?: string;
  requiresAck?: boolean;
  createdAt: string;
  deliveredAt?: string;
  ackedAt?: string;
}
```

### 6.4 Event

```ts
type EventType =
  | 'run.created'
  | 'run.started'
  | 'run.completed'
  | 'agent.started'
  | 'agent.status_changed'
  | 'message.sent'
  | 'message.delivered'
  | 'artifact.updated'
  | 'user.intervened'
  | 'control.paused'
  | 'control.resumed'
  | 'error';

interface RunEvent {
  id: string;
  runId: string;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
```

### 6.5 Artifact

```ts
interface Artifact {
  id: string;
  runId: string;
  title: string;
  path: string;
  mimeType: 'text/markdown' | 'application/json';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

## 7. API specification

### POST /api/runs

Creates a run and starts the runner.

Request:

```json
{
  "title": "BagelCode multi-agent assignment",
  "brief": "여러 AI 에이전트가 협업하는 도구를 만들어줘",
  "mode": "mock",
  "agents": ["planner", "engineer", "reviewer"]
}
```

Response:

```json
{
  "runId": "run_20260430_001",
  "status": "running"
}
```

### GET /api/runs/:runId

Returns run state, agents, task summary, latest artifact metadata.

### GET /api/runs/:runId/events

SSE stream.

Response headers:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

Event frame:

```text
event: message.sent
data: {"id":"evt_1","runId":"run_1","payload":{...}}

```

### POST /api/runs/:runId/interventions

Request:

```json
{
  "to": "engineer",
  "body": "구현 범위를 3일 MVP로 줄여줘",
  "priority": "normal"
}
```

Response:

```json
{
  "ok": true,
  "messageId": "msg_user_001"
}
```

### POST /api/runs/:runId/control

Request:

```json
{
  "action": "pause"
}
```

Supported actions:

- `pause`
- `resume`
- `stop`

## 8. Agent adapter interface

```ts
interface AgentContext {
  runId: string;
  agentId: string;
  role: AgentRole;
  runDir: string;
  inboxPath: string;
  outboxPath: string;
  writeEvent(event: RunEvent): Promise<void>;
  sendMessage(message: Omit<AgentMessage, 'id' | 'createdAt'>): Promise<void>;
}

interface AgentAdapter {
  id: string;
  start(ctx: AgentContext): Promise<void>;
  send(message: AgentMessage): Promise<void>;
  stop(): Promise<void>;
}
```

### MockAgentAdapter

- README default.
- Deterministic scripted behavior.
- Guarantees at least one agent-to-agent message and one final artifact.

### CliAgentAdapter

- Uses `child_process.spawn(command, args, options)`.
- Commands are allowlisted: `codex`, `claude`, `gemini`.
- No arbitrary shell interpolation.
- Agent prompt includes:
  - run context
  - inbox path
  - outbox path
  - instruction to append structured JSONL messages
- Runner watches outbox and routes messages.

## 9. UI specification

### 9.1 Pages

- `/` Run creation page
- `/runs/[runId]` Dashboard

### 9.2 Dashboard layout

```text
┌──────────────────────────────────────────────┐
│ Header: Run title, status, controls           │
├───────────────┬──────────────────────────────┤
│ Agent Cards   │ Event Timeline                │
│ - Planner     │ - run.started                 │
│ - Engineer    │ - planner -> engineer msg     │
│ - Reviewer    │ - user intervention           │
├───────────────┴──────────────────────────────┤
│ Intervention Composer                         │
├──────────────────────────────────────────────┤
│ Artifact Panel                                │
└──────────────────────────────────────────────┘
```

### 9.3 Required components

- `RunCreateForm`
- `RunHeader`
- `AgentCardList`
- `EventTimeline`
- `MessageBubble`
- `InterventionComposer`
- `ArtifactPanel`
- `RunControls`

## 10. File structure

```text
agentboard/
  README.md
  package.json
  next.config.ts
  tsconfig.json
  src/
    app/
      page.tsx
      runs/[runId]/page.tsx
      api/runs/route.ts
      api/runs/[runId]/route.ts
      api/runs/[runId]/events/route.ts
      api/runs/[runId]/interventions/route.ts
      api/runs/[runId]/control/route.ts
    components/
      RunCreateForm.tsx
      AgentCardList.tsx
      EventTimeline.tsx
      InterventionComposer.tsx
      ArtifactPanel.tsx
    lib/
      protocol/types.ts
      store/file-store.ts
      bus/message-bus.ts
      runner/launcher.ts
      runner/main.ts
      agents/mock-agent.ts
      agents/cli-agent.ts
      utils/jsonl.ts
  tests/
    message-bus.test.ts
    file-store.test.ts
    mock-runner.test.ts
```

## 11. Implementation plan

### Day 1: Skeleton and protocol

- Create Next.js TypeScript app.
- Define protocol types.
- Implement JSONL append/read helpers.
- Implement file store.
- Add run creation API.
- Create basic dashboard layout.

Acceptance:

- `pnpm dev` starts app.
- User can create a run.
- Run directory is created under `.agentboard/runs/`.

### Day 2: Mock multi-agent runner

- Implement `MockAgentAdapter`.
- Implement message bus.
- Implement runner process.
- Generate scripted Planner -> Engineer -> Planner -> Reviewer flow.
- Write events and final artifact.

Acceptance:

- Two agents exchange messages.
- Final artifact file is created.
- Unit tests cover message routing.

### Day 3: Realtime dashboard and intervention

- Implement SSE endpoint.
- Implement EventSource client.
- Render live timeline and agent status cards.
- Implement intervention POST API.
- Runner consumes user intervention and changes subsequent artifact content.

Acceptance:

- Timeline updates without refresh.
- User instruction appears as event.
- Agent response acknowledges user instruction.

### Day 4: CLI adapter and controls

- Implement `CliAgentAdapter` shell-safe allowlist.
- Add env config for real CLI mode.
- Implement pause/resume/stop controls.
- Add artifact panel.

Acceptance:

- mock mode remains default.
- CLI mode can be enabled if local CLIs exist.
- Stop terminates child processes.

### Day 5: README, polish, validation

- Write README with exact commands.
- Add sample assignment.
- Add screenshots or GIF optional.
- Add e2e smoke test or manual demo checklist.
- Add limitations/future roadmap.

Acceptance:

- Fresh clone can run mock demo by README only.
- Demo proves agent-agent communication + user observation + user intervention.

## 12. README demo script

```bash
pnpm install
pnpm dev
```

Open:

```text
http://localhost:3000
```

Demo:

1. Click “Start mock collaboration”.
2. Observe Planner -> Engineer messages in Timeline.
3. Send user intervention: “Web Dashboard MVP로 범위를 줄이고 README 실행성을 강조해.”
4. Observe Engineer/Reviewer acknowledge the instruction.
5. Open Artifact Panel and confirm final report includes the user instruction.

Optional CLI mode:

```bash
AGENTBOARD_MODE=cli \
AGENTBOARD_CODEX_CMD=codex \
AGENTBOARD_CLAUDE_CMD=claude \
pnpm dev
```

## 13. Acceptance criteria

- [ ] At least two agents are visible in dashboard.
- [ ] At least one message is sent from agent A to agent B.
- [ ] Browser timeline updates through SSE without manual refresh.
- [ ] User can send a message to a selected agent while run is active.
- [ ] User intervention is persisted in `events.jsonl` and `messages.jsonl`.
- [ ] Final artifact reflects or acknowledges the user intervention.
- [ ] README mock demo runs without external API key.
- [ ] Optional CLI adapter is documented but not required for base demo.

## 14. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Real CLI tools are hard to automate reliably | Make mock mode the default, CLI mode optional adapter. |
| WebSocket complexity slows MVP | Use SSE + POST intervention APIs. |
| Next dev server hot reload resets in-memory state | Persist all run state to JSONL files. |
| Arbitrary command execution risk | Allowlist CLI commands and avoid shell interpolation. |
| Long-running agent process leaks | Track child process IDs and implement stop cleanup. |
| Evaluation machine lacks AI CLIs | README default demo uses mock agents. |

## 15. Future roadmap

- Replace JSONL store with SQLite/Postgres.
- Add WebSocket for bidirectional low-latency control.
- Add auth and multi-user workspaces.
- Add tmux integration as an advanced backend.
- Add run replay and diff view.
- Add evaluation score per agent contribution.
