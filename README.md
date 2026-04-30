# AgentBoard Chat MVP

AgentBoard는 첫 메시지로 여러 AI 에이전트 작업을 시작하고, 협업 과정을 채팅형 UI에서 관찰하며, 진행 중에는 상태 확인과 취소로 흐름을 제어하는 로컬 실행형 MVP입니다.

## 핵심 증명

- Planner, Engineer, Reviewer mock agents가 structured message를 교환합니다.
- 채팅 화면이 SSE(EventSource)로 user-facing message를 실시간 표시하고, 에이전트 간 전달 과정은 상단 `Logs` 버튼에서 확인합니다.
- 진행 중에는 추가 전송을 막고, 현재 작업 agent indicator와 `취소` 버튼을 제공합니다.
- 브라우저별 `clientSessionId`로 최근 run을 연결하고, 루트 페이지에서 이전 대화를 이어갈 수 있습니다.
- 채팅방의 선택 agent, Logs/보고서 열림 상태는 run별로 브라우저에 복원됩니다.
- 기본 mock mode는 Firebase key나 실제 AI CLI 없이 실행됩니다.

## 설치

전제 조건: Node.js 20.9 이상, npm

```bash
npm install
```

## 개발 서버 실행

```bash
npm run dev
```

브라우저에서 접속합니다.

```text
http://localhost:3000
```

## 데모 시나리오

1. 루트(`/`)에서 첫 요청을 채팅 입력창에 작성합니다.
   - 같은 브라우저에서 이전 run이 있으면 `Resume conversation` 카드로 바로 이어갈 수 있습니다.
2. `에이전트 작업 시작` 버튼을 누릅니다.
3. `/runs/<runId>` 채팅방으로 이동합니다.
4. 상단 agent rail에서 agent를 클릭해 현재 상태, 최근 메시지, 최근 이벤트를 확인합니다.
5. 상단 우측 `Logs` 버튼에서 agent 간 메시지 전달 과정을 확인하고, 각 로그를 눌러 전체 내용을 팝업으로 확인합니다.
6. 진행 중에는 하단 composer가 잠기고 현재 작업 indicator와 `취소` 버튼이 표시되는지 확인합니다.
7. 필요하면 `취소`를 눌러 run을 `stopped` 상태로 마무리합니다.
8. 완료된 run에서는 상단의 `보고서 보기` 버튼으로 `final-report.md` 결과를 확인합니다.
9. 루트(`/`)로 돌아가면 같은 브라우저 session의 최근 대화를 이어갈 수 있는 resume 카드가 표시됩니다.

## API

- `POST /api/runs` — run 생성 및 mock runner 시작
- `GET /api/sessions/:clientSessionId` — 브라우저 session의 active/recent run 조회 및 stale run 정리
- `POST /api/sessions/:clientSessionId/active-run` — 열린 채팅방 run을 현재 브라우저 session의 active run으로 연결
- `GET /api/runs/:runId` — run state/events/messages/artifact 조회
- `GET /api/runs/:runId/events` — SSE event stream
- `POST /api/runs/:runId/interventions` — 호환용 사용자 intervention 메시지 기록 API
- `POST /api/runs/:runId/control` — pause/resume/stop. UI 취소 버튼은 `stop` 사용
- `GET /api/runs/:runId/artifact` — final artifact 조회

## 검증

```bash
npm run typecheck
npm test
npm run build
```

## 로컬 상태

실행 중 아래 경로에 JSONL 기반 run state가 생성됩니다.

```text
.agentboard/runs/<runId>/
.agentboard/runs/_sessions/<clientSessionId>.json
```

`.agentboard/`는 gitignore 대상입니다.

브라우저에는 `agentboard:clientSessionId`와 `agentboard:run-ui:<runId>` localStorage key가 저장됩니다. 서버의 `_sessions` index는 run association/resume용이고, ChatRoom UI state는 브라우저 전용입니다. 자세한 세션 복원 계약과 검증 체크리스트는 `docs/architecture.md`, `docs/configuration.md`, `docs/test-writing-guide.md`에 나뉘어 있습니다.

## Optional integrations

- Firebase config는 `docs/configuration.md`를 참고하세요.
- 실제 `codex` CLI adapter는 `cli` mode에서 사용할 수 있습니다. 현재 CLI mode는 Planner, Engineer, Reviewer가 모두 Codex를 사용합니다.

CLI mode 예시:

```bash
AGENTBOARD_MODE=cli \
AGENTBOARD_CODEX_CMD="codex exec" \
npm run dev
```

CLI가 prompt를 인자로 받는 방식이면 `AGENTBOARD_CLI_PROMPT_MODE=append-arg` 또는
`AGENTBOARD_CODEX_PROMPT_MODE=append-arg`를 설정합니다.
