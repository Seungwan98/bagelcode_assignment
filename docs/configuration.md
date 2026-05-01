# Configuration

## 목적

AgentBoard에서 사용하는 설정값, Firebase config, CLI adapter 환경변수, ignore 정책을 설명한다.

## 설정 원칙

- 기본 실행은 `mock` mode다.
- 실제 secret은 commit하지 않는다.
- commit 가능한 파일은 예시 템플릿만 둔다.
- Firebase와 실제 AI CLI는 optional이다.

## 환경변수 파일

커밋 가능한 템플릿:

```text
.env.example
```

로컬 전용 파일:

```text
.env.local
.env.*.local
```

`.env.local`은 `.gitignore` 대상이다.

## App mode

```bash
AGENTBOARD_MODE=mock
```

지원 값:

| 값 | 설명 |
| --- | --- |
| `mock` | 기본값. 외부 key 없이 deterministic agent flow 실행 |
| `cli` | optional. 로컬 AI CLI adapter 사용 |

## Firebase Web config

Firebase client SDK를 사용할 경우 `NEXT_PUBLIC_*` 환경변수를 사용한다.

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=
```

주의:

- `NEXT_PUBLIC_*` 값은 브라우저 번들에 포함된다.
- Firebase Web API key는 private secret처럼 다루지는 않지만, source에 하드코딩하지 않는다.
- Admin SDK private key는 절대 `NEXT_PUBLIC_*`에 넣지 않는다.

## Firebase local JSON config

커밋 가능한 예시:

```text
config/firebase.example.json
```

로컬 실제 값:

```text
config/firebase.local.json
```

초기 설정:

```bash
cp config/firebase.example.json config/firebase.local.json
```

예시 구조:

```json
{
  "apiKey": "YOUR_FIREBASE_WEB_API_KEY",
  "authDomain": "YOUR_PROJECT.firebaseapp.com",
  "projectId": "YOUR_PROJECT_ID",
  "storageBucket": "YOUR_PROJECT.appspot.com",
  "messagingSenderId": "YOUR_MESSAGING_SENDER_ID",
  "appId": "YOUR_FIREBASE_APP_ID",
  "measurementId": "YOUR_GA_MEASUREMENT_ID_OPTIONAL"
}
```

## Firebase Admin config

Admin SDK가 필요해진 뒤에만 설정한다.

허용 방식:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

또는 server-only 환경변수:

```bash
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

금지:

- service account JSON commit
- private key를 `NEXT_PUBLIC_*`에 저장
- `config/firebase.admin.local.json` commit

## CLI adapter config

현재 실제 CLI adapter는 Codex만 사용한다. `AGENTBOARD_MODE=cli` 또는 Chat UI에서 `cli` mode를 선택하면 Orchestrator가 먼저 Agent 실행 계획 JSON을 만들고, 선택된 Planner, Engineer, Reviewer가 같은 Codex 명령을 역할별 prompt와 함께 실행하고, 최종 사용자 답변은 Orchestrator 검증 단계에서 생성한다. Codex stdout은 직접 Agent 간 통신이 아니라 AgentBoard session runtime이 message로 저장하고 다음 Agent prompt context에 주입하는 adapter 출력이다.

```bash
AGENTBOARD_ORCHESTRATOR_ADAPTER=codex
AGENTBOARD_PLANNER_ADAPTER=codex
AGENTBOARD_ENGINEER_ADAPTER=codex
AGENTBOARD_REVIEWER_ADAPTER=codex
AGENTBOARD_CODEX_CMD="codex exec"
AGENTBOARD_CLI_PROMPT_MODE=stdin
AGENTBOARD_CLI_ALLOWLIST=codex
AGENTBOARD_CLI_TIMEOUT_MS=120000
```

지원 adapter 값:

| 값 | 설명 |
| --- | --- |
| `codex` | `AGENTBOARD_CODEX_CMD`로 실행 |
| `tmux-codex` | role별 persistent tmux session에 Codex를 띄우고 AgentBoard 완료 marker를 감지할 때까지 대기 |

prompt 전달 방식:

| 값 | 설명 |
| --- | --- |
| `stdin` | 기본값. prompt를 process stdin으로 전달 |
| `append-arg` | prompt를 마지막 CLI argument로 전달 |

Codex 전용 prompt mode override:

```bash
AGENTBOARD_CODEX_PROMPT_MODE=append-arg
```

명령에 기본 옵션이 필요하면 quote로 감싼다.

```bash
AGENTBOARD_CODEX_CMD="codex exec"
```

## tmux Codex session config

긴 작업을 수행하는 실제 Codex 실행은 role별 adapter를 `tmux-codex`로 설정하는 것을 권장한다. 이 모드에서는 AgentBoard가 prompt에 transport 완료 marker 규칙을 추가하고, tmux pane을 polling하여 `AGENTBOARD_DONE` marker가 보일 때 `session.completed` 이벤트를 기록한다. Codex가 `AGENTBOARD_BEGIN` 이후 답변을 끝냈지만 `AGENTBOARD_DONE`을 누락한 채 idle prompt(`›`)로 돌아온 경우에는 같은 출력이 `AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS` 동안 안정적으로 유지된 뒤에만 `completionSource=idle-prompt-fallback`으로 완료 처리한다.

```bash
AGENTBOARD_ORCHESTRATOR_ADAPTER=tmux-codex
AGENTBOARD_PLANNER_ADAPTER=tmux-codex
AGENTBOARD_ENGINEER_ADAPTER=tmux-codex
AGENTBOARD_REVIEWER_ADAPTER=tmux-codex
AGENTBOARD_CODEX_CMD="codex --no-alt-screen"
AGENTBOARD_TMUX_CMD=tmux
AGENTBOARD_TMUX_ALLOWLIST=tmux
AGENTBOARD_TMUX_COMPLETION_TIMEOUT_MS=600000
AGENTBOARD_TMUX_COMPLETION_POLL_MS=1000
AGENTBOARD_TMUX_READY_TIMEOUT_MS=20000
AGENTBOARD_TMUX_READY_POLL_MS=250
AGENTBOARD_TMUX_PASTE_READY_TIMEOUT_MS=2000
AGENTBOARD_TMUX_SUBMIT_DELAY_MS=1000
AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS=30000
AGENTBOARD_TMUX_CAPTURE_HISTORY_LINES=1000
```

tmux 관련 값:

| 값 | 기본값 | 설명 |
| --- | --- | --- |
| `AGENTBOARD_TMUX_CMD` | `tmux` | 실행할 tmux command |
| `AGENTBOARD_TMUX_ALLOWLIST` | `tmux` | 허용할 tmux executable 이름 |
| `AGENTBOARD_TMUX_COMPLETION_TIMEOUT_MS` | `600000` | 완료 marker를 기다릴 최대 시간 |
| `AGENTBOARD_TMUX_COMPLETION_POLL_MS` | `1000` | `capture-pane` polling 간격 |
| `AGENTBOARD_TMUX_READY_TIMEOUT_MS` | `20000` | Codex TUI가 prompt를 받을 준비가 될 때까지 기다릴 최대 시간 |
| `AGENTBOARD_TMUX_READY_POLL_MS` | `250` | Codex TUI ready check polling 간격 |
| `AGENTBOARD_TMUX_PASTE_READY_TIMEOUT_MS` | `2000` | prompt paste가 Codex 입력창에 반영될 때까지 기다릴 최대 시간 |
| `AGENTBOARD_TMUX_SUBMIT_DELAY_MS` | `1000` | prompt paste 후 Enter submit 전 대기 시간. 긴 paste가 `[Pasted Content ...]`로 접히는 동안 Enter가 너무 빨리 들어가면 input line에 머물 수 있으므로 기본값은 1초다. |
| `AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS` | `30000` | `AGENTBOARD_DONE`이 누락된 경우 idle prompt 기반 fallback을 적용하기 전 동일 출력이 안정적으로 유지되어야 하는 시간. 스트리밍 중 부분 출력이 JSON parse fallback으로 오인되는 것을 막는다. |
| `AGENTBOARD_TMUX_CAPTURE_HISTORY_LINES` | `400` | 완료 marker 탐색에 사용할 pane history line 수 |
| `AGENTBOARD_TMUX_CAPTURE_DELAY_MS` | `1000` | prompt 주입 직후 첫 capture 전 대기 시간 |

완료 통보 기준:

- 정상 완료: `session.completed` event와 session status `completed`
- 추가 입력/진행 불가: `session.completed` event의 `markerStatus=blocked`, session status `blocked`
- timeout: `session.completion_timeout` event와 session status `blocked`
- 긴 prompt 주입: AgentBoard는 prompt를 `.agentboard/runs/<runId>/tmux-prompts/` 임시 파일로 저장한 뒤 `tmux load-buffer`로 주입하고 즉시 삭제한다. `session.prompt_injected` event의 `promptTransport` 값은 `tmux-load-buffer-file`이다.
- DONE marker 누락 fallback: `AGENTBOARD_BEGIN` 이후 유효한 output이 있고 Codex가 idle prompt로 돌아오면, 같은 출력이 `AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS` 동안 안정적으로 유지된 뒤 `session.completed` event에 `completionSource=idle-prompt-fallback`을 기록한다.
- 권한 요청: Codex가 `Would you like to run the following command?` 프롬프트에서 대기하면 `approval.requested` event를 기록하고 해당 Agent 채팅창에 승인/거절 카드를 표시한다. 승인/거절은 `POST /api/runs/<runId>/approvals`를 통해 tmux pane에 `Enter` 또는 `Escape`를 주입한다.

주의:

- `tmux-codex`는 persistent pane에 prompt를 계속 주입하므로 `codex exec`보다 interactive `codex --no-alt-screen`을 권장한다.
- `codex exec`는 one-shot 실행용이라 tmux pane 안에서 완료 marker를 안정적으로 기다리는 구조와 맞지 않는다.

보안 규칙:

- command allowlist를 사용한다.
- `spawn(command, args, { shell: false })` 형태를 우선한다.
- 사용자 입력을 shell 문자열로 이어붙이지 않는다.
- `|`, `;`, `&`, redirect 같은 shell metacharacter가 있는 command spec은 거부한다.

## Local state config

MVP local state root:

```text
.agentboard/runs/
```

권장 구조:

```text
.agentboard/runs/<runId>/events.jsonl
.agentboard/runs/<runId>/messages.jsonl
.agentboard/runs/<runId>/artifacts/final-report.md
.agentboard/runs/_sessions/<clientSessionId>.json
```

`.agentboard/`는 commit하지 않는다.

## Session persistence config

브라우저별 session resume는 local file store와 browser localStorage만 사용한다.

서버 저장 항목:

- `Run.clientSessionId`
- `_sessions/<clientSessionId>.json`의 `activeRunId`, `recentRunIds`

브라우저 저장 항목:

- `agentboard:clientSessionId`
- `agentboard:run-ui:<runId>`

오래된 `running` run을 stale로 바꾸는 threshold는 기본 15분이다.

```bash
AGENTBOARD_STALE_RUN_MS=900000
```

이 값은 로컬 process 재시작 뒤 resume UI에서 안전하게 “더 이상 실행 중이라고 신뢰하지 않는 run”을 표시하기 위한 것이다. 인증이나 보안 판단에 사용하지 않는다.

## Git ignore 대상

반드시 ignore되어야 하는 항목:

```text
.env.local
.env.*.local
config/firebase.local.json
config/firebase.admin.local.json
config/firebase-service-account*.json
.agentboard/
.next/
node_modules/
coverage/
logs/
```

## Commit message config

커밋 메시지는 한글 기반 `[Type]` 형식을 사용한다.

```text
[Feat] 첫 번째 커밋
[Docs] 설정 문서 정리
[Chore] 로컬 비밀값 ignore 처리
```
