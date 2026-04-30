# AgentBoard Chat MVP

AgentBoard는 여러 AI 에이전트가 메시지를 주고받는 협업 과정을 채팅형 UI에서 관찰하고, 사용자가 실행 중 직접 지시를 추가할 수 있게 하는 로컬 실행형 MVP입니다.

## 핵심 증명

- Planner, Engineer, Reviewer mock agents가 structured message를 교환합니다.
- 채팅 화면이 SSE(EventSource)로 agent/user message와 artifact를 실시간 표시합니다.
- 사용자가 특정 agent 또는 `all`에 intervention을 전송할 수 있습니다.
- 사용자 intervention은 message/event log에 저장되고 agent ack 및 final artifact에 반영됩니다.
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

1. 루트(`/`)에서 과제 brief를 입력합니다.
2. `대화 시작` 버튼을 누릅니다.
3. `/runs/<runId>` 채팅방으로 이동합니다.
4. 채팅 버블에서 agent 간 메시지를 확인합니다.
5. 하단 채팅 입력창에서 다음 예시를 전송합니다.

   ```text
   구현 범위를 ASAP MVP로 줄이고 README 실행성을 우선해줘.
   ```

6. 채팅방에서 `user.intervened`와 agent `ack` 메시지를 확인합니다.
7. 대화 마지막의 artifact 버블에서 `final-report.md` 결과를 확인합니다.

## API

- `POST /api/runs` — run 생성 및 mock runner 시작
- `GET /api/runs/:runId` — run state/events/messages/artifact 조회
- `GET /api/runs/:runId/events` — SSE event stream
- `POST /api/runs/:runId/interventions` — 사용자 intervention 메시지 전송
- `POST /api/runs/:runId/control` — pause/resume/stop
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
```

`.agentboard/`는 gitignore 대상입니다.

## Optional integrations

- Firebase config는 `docs/configuration.md`를 참고하세요.
- 실제 `codex`, `claude`, `gemini` CLI adapter는 `cli` mode에서 사용할 수 있습니다.

CLI mode 예시:

```bash
AGENTBOARD_MODE=cli \
AGENTBOARD_CODEX_CMD="codex" \
AGENTBOARD_CLAUDE_CMD="claude" \
AGENTBOARD_GEMINI_CMD="gemini" \
npm run dev
```

CLI가 prompt를 인자로 받는 방식이면 `AGENTBOARD_CLI_PROMPT_MODE=append-arg` 또는
`AGENTBOARD_<CODEX|CLAUDE|GEMINI>_PROMPT_MODE=append-arg`를 설정합니다.
