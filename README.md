# AgentBoard Web Dashboard MVP

AgentBoard는 여러 AI 에이전트가 메시지를 주고받는 협업 과정을 Web Dashboard에서 관찰하고, 사용자가 실행 중 직접 지시를 추가할 수 있게 하는 로컬 실행형 MVP입니다.

## 핵심 증명

- Planner, Engineer, Reviewer mock agents가 structured message를 교환합니다.
- Dashboard가 SSE(EventSource) timeline으로 run event를 실시간 표시합니다.
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
2. `Start mock collaboration` 버튼을 누릅니다.
3. `/runs/<runId>` Dashboard로 이동합니다.
4. Agent cards와 Event Timeline에서 agent 간 메시지를 확인합니다.
5. User Intervention 영역에서 다음 예시를 전송합니다.

   ```text
   구현 범위를 ASAP MVP로 줄이고 README 실행성을 우선해줘.
   ```

6. Timeline에서 `user.intervened`와 agent `ack` 메시지를 확인합니다.
7. Artifact panel에서 `final-report.md` 결과를 확인합니다.

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
- 실제 `codex`, `claude`, `gemini` CLI adapter는 optional 확장입니다.
