# AgentBoard Chat MVP

AgentBoard는 ChatGPT처럼 사용자가 메시지를 보내면 Orchestrator가 필요한 Agent를 배정하고, 선택된 Planner, Engineer, Reviewer가 협업해 답변하는 과정을 채팅형 UI에서 관찰할 수 있는 로컬 실행형 MVP입니다.

## 핵심 증명

- Orchestrator가 사용자 요청을 분석해 필요한 Agent 실행 계획 JSON을 만들고, AgentBoard message bus를 통해 structured assignment/handoff message를 교환합니다.
- 루트 화면은 처음부터 챗봇형 workspace이며, 좌측 세션 목록에서 대화별 기록을 선택/생성할 수 있습니다.
- 채팅 화면이 SSE(EventSource)로 user-facing message를 실시간 표시하고, 에이전트 간 전달 과정은 `Agent Collaboration` 타임라인과 `Logs` 버튼에서 확인합니다.
- 사용자가 메시지를 보내면 Agents가 답변을 생성하고, 생성 중에도 추가 지시를 보내거나 `취소` 버튼으로 중단할 수 있습니다.
- 브라우저별 `clientSessionId`로 최근 run을 연결하고, 루트 페이지에서 이전 대화를 이어갈 수 있습니다.
- 좌측 세션 목록에서 완료/중단된 대화를 삭제할 수 있습니다.
- 채팅방의 선택 agent, Logs/보고서 열림 상태는 run별로 브라우저에 복원됩니다.
- 기본 mock mode는 외부 key나 실제 AI CLI 없이 실행됩니다.
- 실제 Codex 실행은 `tmux-codex` persistent session을 권장하며, 출력은 AgentBoard session runtime에 저장되고 다음 Agent prompt context로 주입됩니다.

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

1. 루트(`/`)에서 바로 보이는 챗봇 composer에 첫 요청을 작성합니다.
   - 같은 브라우저에서 이전 run이 있으면 좌측 세션 목록에 최근 대화가 표시됩니다.
2. `전송` 버튼을 누르면 새 run이 생성되고 중앙 채팅 영역에서 바로 대화가 시작됩니다.
3. 좌측 세션 목록에서 다른 대화를 선택해 기록을 전환합니다.
4. 상단 agent rail에서 agent를 클릭해 현재 상태, 최근 메시지, 최근 이벤트를 확인합니다.
5. `Agent Collaboration` 타임라인에서 agent 간 메시지 전달 과정을 확인하고, `Logs` 버튼에서 raw event payload를 팝업으로 확인합니다.
6. Agents가 답변을 생성하는 동안 composer가 잠기고 현재 작업 indicator와 `취소` 버튼이 표시되는지 확인합니다.
7. 답변이 완료되면 같은 composer에 다음 질문을 입력해 다시 Agents 응답을 받을 수 있습니다.
8. 필요하면 `취소`를 눌러 현재 답변 생성을 `stopped` 상태로 마무리합니다.
9. 완료/중단된 대화는 좌측 목록의 `삭제` 버튼으로 제거할 수 있습니다.

## API

- `POST /api/runs` — run 생성 및 mock runner 시작
- `GET /api/sessions/:clientSessionId` — 브라우저 session의 active/recent run 조회 및 stale run 정리
- `POST /api/sessions/:clientSessionId/active-run` — 열린 채팅방 run을 현재 브라우저 session의 active run으로 연결
- `GET /api/runs/:runId` — run state/events/messages/artifact 조회
- `GET /api/runs/:runId/events` — SSE event stream
- `POST /api/runs/:runId/interventions` — 같은 채팅방에서 새 사용자 요청을 저장하고 Agents 답변 생성을 시작
- `POST /api/runs/:runId/control` — pause/resume/stop. UI 취소 버튼은 `stop` 사용
- `DELETE /api/runs/:runId` — 완료/중단된 run 삭제 및 session 목록 제거
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

- 실제 `codex` CLI adapter는 `cli` mode에서 사용할 수 있습니다. 제출/시연용 실제 실행은 role별 `tmux-codex` session을 권장합니다. AgentBoard가 session context, 완료 marker, 권한 요청 이벤트를 관리합니다.

권장 CLI mode 예시:

```bash
AGENTBOARD_MODE=cli \
AGENTBOARD_CODEX_CMD="codex --no-alt-screen" \
npm run dev
```

`cli` mode에서 role별 adapter 환경변수를 생략하면 기본값은 모두 `tmux-codex`입니다.
`codex exec` 기반 one-shot adapter는 짧은 smoke 실행용 fallback으로만 사용합니다.
