# Configuration

## 목적

AgentBoard에서 사용하는 설정값, CLI adapter 환경변수, ignore 정책을 설명한다.

## 설정 원칙

- 기본 실행은 `mock` mode다.
- 실제 secret은 commit하지 않는다.
- commit 가능한 파일은 예시 템플릿만 둔다.
- 실제 AI CLI는 optional이며, 사용할 경우 `tmux-codex`를 우선한다.

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
| `cli` | optional. 로컬 Codex adapter 사용. 실제 작업은 `tmux-codex` 권장 |


## CLI adapter config

현재 실제 AI adapter는 Codex만 사용한다. 기본 데모는 여전히 `mock` mode이며, `AGENTBOARD_MODE=cli` 또는 Chat UI의 `cli` mode는 로컬 Codex가 준비된 경우에만 사용한다. 실제 작업과 시연은 role별 persistent session을 유지하는 `tmux-codex`를 우선한다. Codex 출력은 직접 Agent 간 통신 채널이 아니라 AgentBoard session runtime이 message로 저장하고 다음 Agent prompt context에 주입하는 adapter 출력이다.

role별 adapter 환경변수를 생략하면 `cli` mode의 기본 adapter는 모두 `tmux-codex`다. `codex` one-shot adapter는 명시적으로 설정했을 때만 사용한다.

지원 adapter 값:

| 값 | 권장도 | 설명 |
| --- | --- | --- |
| `tmux-codex` | 권장 | role별 persistent tmux session에 Codex를 띄우고 AgentBoard 완료 marker, idle fallback, 권한 요청 이벤트를 처리 |
| `codex` | fallback | `codex exec` 같은 one-shot command 실행. 짧은 smoke 검증용으로만 사용 |

권장 `tmux-codex` 설정:

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

One-shot Codex fallback:

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

이 fallback은 process stdout 종료에 의존하므로 긴 작업, 권한 prompt, session 유지가 중요한 시연에는 사용하지 않는다. CLI가 prompt를 argument로 받는 경우에만 `AGENTBOARD_CODEX_PROMPT_MODE=append-arg` 또는 `AGENTBOARD_CLI_PROMPT_MODE=append-arg`를 사용한다.

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
