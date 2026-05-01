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


## 사용자 요청에 Agents 답변이 생성되지 않음

### 가능한 원인

- `POST /api/runs/<runId>/interventions` 요청이 실패했다.
- run이 아직 `running` 상태라 중복 요청이 409로 거절됐다.
- Runner가 답변 생성 중 오류를 남겼다.

### 확인

```bash
cat .agentboard/runs/<runId>/messages.jsonl
cat .agentboard/runs/<runId>/events.jsonl
cat .agentboard/runs/<runId>/state.json
```

사용자 요청은 `from: "user"`, 답변은 `from: "reviewer"`, `to: "user"` 메시지로 남아야 한다.

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

## 좌측 최근 대화 목록이 보이지 않음

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

## 대화 삭제가 되지 않음

### 가능한 원인

- run이 아직 `created`, `running`, `paused` 상태다.
- local run directory가 이미 삭제되어 session index와 불일치한다.
- 브라우저가 오래된 session snapshot을 보고 있다.

### 확인

```bash
cat .agentboard/runs/<runId>/state.json
```

진행 중인 run은 먼저 UI의 `취소` 버튼으로 `stopped` 상태로 만든 뒤 삭제한다. 이미 directory가 없으면 좌측 목록의 새로고침 또는 페이지 새로고침으로 session snapshot을 다시 읽는다.

## Agent 패널/Logs에 agent 간 메시지가 보이지 않음

### 가능한 원인

- 아직 Orchestrator가 Agent에게 업무를 배정하기 전이다.
- 선택된 run에 agent-to-agent 메시지가 없다.
- Logs에는 event가 있으나 message payload가 없는 시스템 이벤트만 기록됐다.
- Agent 패널이 특정 role의 메시지만 필터링하고 있다.

### 확인

```bash
cat .agentboard/runs/<runId>/messages.jsonl
```

`from`과 `to`가 모두 agent id인 메시지가 있으면 4분할 Agent 채팅 패널 또는 Logs drawer에 표시되어야 한다.

## Orchestrator JSON parse fallback이 발생함

### 증상

```text
Strategy: fallback-linear-orchestrator
Reason: Orchestrator 출력 JSON을 파싱하지 못해 기본 순서를 사용합니다.
Parse Error: orchestrator output does not contain a JSON object
```

### 가능한 원인

- Orchestrator Agent가 JSON plan 대신 설명 문장만 출력했다.
- `tmux-codex`가 `AGENTBOARD_DONE` marker를 받기 전의 부분 출력만 capture했다.
- `AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS`가 너무 낮아 스트리밍 중 output을 완료로 오인했다.

### 확인

```bash
cat .agentboard/runs/<runId>/events.jsonl | grep -E "session.completed|idle-prompt-fallback|orchestrator"
cat .agentboard/runs/<runId>/messages.jsonl
tmux capture-pane -pt <session>:<window>.<pane> -S -200
```

`session.completed`에 `completionSource: "idle-prompt-fallback"`이 있고 직후 실제 pane에는 JSON과 `AGENTBOARD_DONE`이 보이면 fallback이 너무 빨리 적용된 것이다.

### 해결

- dev server를 재시작해 최신 adapter 코드를 반영한다.
- `AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS=30000` 이상으로 둔다.
- Orchestrator prompt는 JSON object 하나를 출력하도록 유지한다.
- 같은 문제가 반복되면 해당 run의 `events.jsonl`, `messages.jsonl`, tmux pane capture를 함께 비교한다.

## tmux-codex 권한 요청에서 멈춘 것처럼 보임

### 가능한 원인

- Codex가 command 실행 권한을 요청했지만 Web UI에서 승인/거절하지 않았다.
- 브라우저가 SSE를 놓쳐 `approval.requested` 카드가 보이지 않는다.
- 승인 API 호출은 성공했지만 tmux pane 주입이 실패했다.

### 확인

```bash
cat .agentboard/runs/<runId>/events.jsonl | grep approval
cat .agentboard/runs/<runId>/state.json
```

### 해결

- 해당 Agent 채팅 패널의 승인/거절 카드를 누른다.
- 카드가 보이지 않으면 페이지를 새로고침하고 Logs drawer에서 `approval.requested` event를 확인한다.
- 수동 확인이 필요하면 tmux pane에서 Codex 권한 prompt가 떠 있는지 본다.
- API로 처리하려면 `POST /api/runs/<runId>/approvals`에 `approvalId`, `decision` 값을 보낸다.

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

## `DerivedData` 또는 `Index.noindex`가 Git에 잡힘

### 의미

`TaskFlowMVVM/DerivedData`, `Index.noindex`, `xcuserdata`는 Xcode/Swift 빌드와 indexing 과정에서 생기는 로컬 생성물이다. AgentBoard 코드나 문서 산출물이 아니므로 commit하지 않는다.

### 확인

```bash
git status --short --ignored | grep -E "DerivedData|noindex|xcuserdata"
git check-ignore TaskFlowMVVM/DerivedData TaskFlowMVVM/DerivedData/Index.noindex
```

### 해결

`.gitignore`가 최신이면 ignored로 보여야 한다. 필요하면 로컬 cache를 삭제한다.

```bash
rm -rf TaskFlowMVVM/DerivedData TaskFlowMVVM/Derived
```

## 문서와 구현이 어긋남

### 증상

- 문서에는 Firebase 기본 실행이라고 되어 있지만 실제로는 mock mode가 기본임
- API 경로가 문서와 다름
- commit 규칙이 문서마다 다름

### 해결

- `AGENTS.md`와 `docs/`를 함께 갱신한다.
- architecture/configuration/test/troubleshooting/extending 문서가 같은 용어를 쓰는지 확인한다.
