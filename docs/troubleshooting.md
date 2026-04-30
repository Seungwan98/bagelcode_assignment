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

## Dashboard가 비어 있음

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

## Timeline이 실시간으로 갱신되지 않음

### 가능한 원인

- `GET /api/runs/<runId>/events` route가 `text/event-stream` header를 반환하지 않는다.
- browser `EventSource`가 잘못된 runId로 연결됐다.
- dev server가 route handler를 재시작했다.

### 해결

- Network tab에서 SSE response header 확인
- 서버 로그 확인
- 페이지 새로고침
- `events.jsonl`에 이벤트가 append되는지 확인

## 사용자 개입이 반영되지 않음

### 가능한 원인

- `POST /api/runs/<runId>/interventions` 요청 실패
- target agent id가 잘못됨
- Message Bus가 target inbox에 쓰지 못함
- Mock runner가 user inbox polling을 하지 않음

### 확인

```bash
cat .agentboard/runs/<runId>/messages.jsonl
cat .agentboard/runs/<runId>/agents/<agentId>/inbox.jsonl
```

`from: "user"`, `kind: "user_intervention"` 메시지가 있어야 한다.

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
- CLI mode가 필요한 경우 로컬에 해당 CLI가 설치되어 있고 환경변수가 설정되어 있는지 확인한다.

```bash
command -v codex
command -v claude
command -v gemini
```

환경변수도 확인한다.

```bash
echo $AGENTBOARD_CODEX_CMD
echo $AGENTBOARD_CLAUDE_CMD
echo $AGENTBOARD_GEMINI_CMD
echo $AGENTBOARD_CLI_PROMPT_MODE
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
