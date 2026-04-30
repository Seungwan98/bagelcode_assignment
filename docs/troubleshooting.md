# Troubleshooting

## 앱이 실행되지 않음

### 증상

```text
npm run dev
command not found: npm
```

### 해결

Node.js와 npm 설치 상태를 확인한다.

```bash
node -v
npm -v
```

## 채팅방이 비어 있음

### 가능한 원인

- Run이 생성되지 않았다.
- Runner process가 시작되지 않았다.
- `.agentboard/runs/<runId>/events.jsonl`이 비어 있다.
- SSE 연결이 끊겼다.

### 확인

```bash
find .agentboard/runs -maxdepth 3 -type f | sort
cat .agentboard/runs/<runId>/events.jsonl
cat .agentboard/runs/<runId>/messages.jsonl
```

## 채팅 메시지가 실시간으로 갱신되지 않음

### 가능한 원인

- `GET /api/runs/<runId>/events` route가 `text/event-stream` header를 반환하지 않는다.
- browser `EventSource`가 잘못된 runId로 연결됐다.
- dev server가 route handler를 재시작했다.

### 해결

- 브라우저 Network tab에서 SSE response header 확인
- 서버 로그 확인
- 페이지 새로고침
- `events.jsonl`에 이벤트가 append되는지 확인

## 진행 중 취소가 반영되지 않음

### 가능한 원인

- `POST /api/runs/<runId>/control` 요청 실패
- runId가 잘못됨
- mock/CLI runner stop 함수가 호출되지 않음
- 이미 terminal 상태인 run을 보고 있음

### 확인

```bash
cat .agentboard/runs/<runId>/state.json
cat .agentboard/runs/<runId>/events.jsonl
```

`status: "stopped"`와 `control.stopped` event가 있어야 한다.

## Final artifact가 생성되지 않음

### 가능한 원인

- Runner가 완료 상태까지 진행하지 못함
- Artifact writer 경로가 잘못됨
- Agent result 메시지가 생성되지 않음

### 확인

```bash
ls -la .agentboard/runs/<runId>/artifacts
cat .agentboard/runs/<runId>/artifacts/final-report.md
```

## 최근 대화 resume 카드가 보이지 않음

### 가능한 원인

- 브라우저 localStorage의 `agentboard:clientSessionId`가 삭제됐다.
- 새 run 생성 요청에 `clientSessionId`가 전달되지 않았다.
- `.agentboard/runs/_sessions/<clientSessionId>.json`이 없거나 손상됐다.
- recent run directory가 삭제됐다.

### 확인

브라우저 DevTools에서 localStorage를 확인한다.

```text
agentboard:clientSessionId
```

서버 local state도 확인한다.

```bash
find .agentboard/runs/_sessions -maxdepth 1 -type f | sort
cat .agentboard/runs/_sessions/<clientSessionId>.json
```

session 파일이 없으면 새 run을 만들면 다시 생성된다. 손상된 session 파일은 로컬 상태이므로 백업 뒤 삭제하고 다시 시작할 수 있다.

## 실행 중이던 run이 stale로 표시됨

### 의미

`stale`은 로컬 서버 또는 runner process가 중단되어 더 이상 `running` 상태를 신뢰할 수 없다는 안전 표시다. 결과 기록은 남아 있으므로 `/runs/<runId>`에서 메시지와 artifact를 확인할 수 있다.

### 확인/조정

기본 stale threshold는 15분이다. 로컬 실험에서 더 길게 유지하려면 dev server 실행 전에 설정한다.

```bash
AGENTBOARD_STALE_RUN_MS=1800000 npm run dev
```

stale run을 계속 진행시키는 resume-runner 기능은 MVP 범위가 아니다. 새 run을 생성하거나 기존 기록을 참고해 후속 지시를 다시 시작한다.

## Firebase 관련 오류

### 증상

```text
Firebase: Error (auth/invalid-api-key)
```

### 해결

- Mock mode에서는 Firebase가 필요 없어야 한다.
- Firebase mode를 켠 경우 `.env.local` 또는 `config/firebase.local.json` 값을 확인한다.
- `NEXT_PUBLIC_FIREBASE_API_KEY`가 비어 있지 않은지 확인한다.

### 주의

Firebase Admin private key를 client 환경변수에 넣지 않는다.

## CLI adapter가 실행되지 않음

### 증상

```text
spawn codex ENOENT
```

### 해결

- Mock mode로 먼저 실행한다.
- CLI mode가 필요한 경우 로컬에 Codex CLI가 설치되어 있고 환경변수가 설정되어 있는지 확인한다.

```bash
command -v codex
```

환경변수도 확인한다.

```bash
echo $AGENTBOARD_CODEX_CMD
echo $AGENTBOARD_CLI_PROMPT_MODE
```

`codex adapter exited with code 1`이 바로 발생하면 interactive `codex`가 실행된 경우일 수 있다. AgentBoard는 non-interactive 실행이 필요하므로 command를 다음처럼 둔다.

```bash
AGENTBOARD_CODEX_CMD="codex exec"
AGENTBOARD_CLI_PROMPT_MODE=stdin
```

`CLI_CONFIG_INVALID`가 나오면 command allowlist와 role adapter 설정을 확인한다.

```bash
echo $AGENTBOARD_CLI_ALLOWLIST
echo $AGENTBOARD_PLANNER_ADAPTER
echo $AGENTBOARD_ENGINEER_ADAPTER
echo $AGENTBOARD_REVIEWER_ADAPTER
```

## Git에 secret 또는 run state가 잡힘

### 증상

```bash
git status --short
```

결과에 아래 파일이 보인다.

```text
.env.local
config/firebase.local.json
.agentboard/runs/...
```

### 해결

`.gitignore`를 확인한다.

```bash
git check-ignore .env.local config/firebase.local.json .agentboard/runs/example/events.jsonl
```

이미 staged 됐다면 unstage한다.

```bash
git restore --staged .env.local config/firebase.local.json .agentboard
```

## 문서와 구현이 어긋남

### 증상

- 문서에는 Firebase 기본 실행이라고 되어 있지만 실제로는 mock mode가 기본임
- API 경로가 문서와 다름
- commit 규칙이 문서마다 다름

### 해결

- `AGENTS.md`와 `docs/`를 함께 갱신한다.
- architecture/configuration/test/troubleshooting/extending 문서가 같은 용어를 쓰는지 확인한다.
