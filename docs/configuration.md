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
AGENTBOARD_TMUX_PROMPT_TRANSPORT=file-reference
AGENTBOARD_ORCHESTRATOR_TMUX_PROMPT_TRANSPORT=paste-buffer
AGENTBOARD_TMUX_PASTE_READY_TIMEOUT_MS=2000
AGENTBOARD_TMUX_SUBMIT_DELAY_MS=1000
AGENTBOARD_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS=3000
AGENTBOARD_TMUX_SUBMIT_RETRY_COUNT=4
AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS=30000
AGENTBOARD_TMUX_CAPTURE_HISTORY_LINES=1000
# 선택: 안전한 반복 검증 명령만 자동 승인
# AGENTBOARD_AUTO_APPROVE_COMMANDS=swift test,npm test,npm run typecheck
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
| `AGENTBOARD_TMUX_PROMPT_TRANSPORT` | `file-reference` | 긴 prompt 전체를 붙여넣지 않고 prompt 파일 경로를 짧게 전달하는 기본 transport. 기존 방식은 `paste-buffer` |
| `AGENTBOARD_<ROLE>_TMUX_PROMPT_TRANSPORT` | 없음 | 특정 role만 transport를 override한다. `<ROLE>`은 `ORCHESTRATOR`, `PLANNER`, `ENGINEER`, `REVIEWER` 중 하나이며 값은 `file-reference` 또는 `paste-buffer` |
| `AGENTBOARD_TMUX_PASTE_READY_TIMEOUT_MS` | `2000` | prompt instruction paste가 Codex 입력창에 반영될 때까지 기다릴 최대 시간 |
| `AGENTBOARD_TMUX_SUBMIT_DELAY_MS` | `1000` | prompt instruction paste 후 Enter submit 전 대기 시간 |
| `AGENTBOARD_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS` | `3000` | Enter/C-m 전송 후 Codex가 실제 처리 상태로 들어갔는지 확인할 최대 시간. 응답이 없으면 짧게 재시도해 submit 단계가 오래 묶이지 않게 한다. |
| `AGENTBOARD_TMUX_SUBMIT_RETRY_COUNT` | `4` | prompt submit 확인 실패 시 추가 submit key 재시도 횟수. Codex TUI가 file-reference instruction 입력 후 첫 Enter/C-m을 줄바꿈처럼 처리하는 경우가 있어 기본값을 보수적으로 둔다. |
| `AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS` | `30000` | `AGENTBOARD_DONE`이 누락된 경우 idle prompt 기반 fallback을 적용하기 전 동일 출력이 안정적으로 유지되어야 하는 시간. 스트리밍 중 부분 출력이 JSON parse fallback으로 오인되는 것을 막는다. |
| `AGENTBOARD_TMUX_CAPTURE_HISTORY_LINES` | `400` | 완료 marker 탐색에 사용할 pane history line 수 |
| `AGENTBOARD_TMUX_CAPTURE_DELAY_MS` | `1000` | prompt 주입 직후 첫 capture 전 대기 시간 |
| `AGENTBOARD_AUTO_APPROVE_COMMANDS` | 없음 | Codex 권한 프롬프트 command가 이 allowlist와 일치하면 AgentBoard가 자동 승인한다. 쉼표/줄바꿈 구분, `*` glob 지원. 예: `swift test,npm test,npm run typecheck` |
| `AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS` | `5` | Orchestrator가 incomplete verdict 후 다시 Agent에게 보완을 맡길 최대 횟수 |

완료 통보 기준:

- 정상 완료: `session.completed` event와 session status `completed`
- 추가 입력/진행 불가: `session.completed` event의 `markerStatus=blocked`, session status `blocked`
- timeout: `session.completion_timeout` event와 session status `blocked`
- submit 실패: `session.prompt_submit_failed` event와 session status `blocked`. 입력창에 prompt instruction이 남아 실제 실행이 시작되지 않은 상태를 completion timeout과 분리해 빠르게 표시한다.
- 긴 prompt 주입: 기본값은 `tmux-file-reference`다. AgentBoard는 전체 prompt를 `.agentboard/runs/<runId>/tmux-prompts/` 파일로 저장하고, tmux에는 해당 파일을 읽으라는 짧은 instruction만 `tmux load-buffer`로 주입한다. 완료/실패 후 prompt 파일은 삭제된다. `AGENTBOARD_TMUX_PROMPT_TRANSPORT=paste-buffer`를 설정하면 기존처럼 전체 prompt를 `tmux-load-buffer-file`로 직접 붙여넣는다.
- Orchestrator 빠른 handoff: 사용자 입력을 받아 route/plan을 만드는 Orchestrator는 상대적으로 prompt가 짧으므로 `AGENTBOARD_ORCHESTRATOR_TMUX_PROMPT_TRANSPORT=paste-buffer`를 권장한다. Planner/Engineer/Reviewer는 긴 작업 지시가 많아 전역 기본값 `file-reference`를 유지한다.
- DONE marker 누락 fallback: `AGENTBOARD_BEGIN` 이후 유효한 output이 있고 Codex가 idle prompt로 돌아오면, 같은 출력이 `AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS` 동안 안정적으로 유지된 뒤 `session.completed` event에 `completionSource=idle-prompt-fallback`을 기록한다. Marker가 모두 누락돼도 pasted prompt 이후 실제 output이 생성되고 idle prompt로 돌아오면 `completionSource=idle-output-fallback`으로 기록한다.
- 권한 요청: Codex가 `Would you like to run the following command?` 프롬프트에서 대기하면 `approval.requested` event를 기록하고 해당 Agent 채팅창에 승인/거절 카드를 표시한다. 승인/거절은 `POST /api/runs/<runId>/approvals`에 `action: "approve" | "reject"`를 보내 tmux pane에 `Enter` 또는 `Escape`를 주입한다. 원본 `1) 2) 3)` 선택지는 raw log payload에서만 확인하고 기본 UI는 승인/거절 버튼으로 단순화한다. `AGENTBOARD_AUTO_APPROVE_COMMANDS`에 일치하는 command는 `approval.requested` 직후 `approval.approved`를 `source=auto`로 기록하고 자동 진행한다.

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
.agentboard/workspaces/<runId>/
```

`.agentboard/`는 commit하지 않는다.

실제 구현 요청(`deliverableType=implementation`)은 기본적으로 run별 workspace를 사용한다.

```text
.agentboard/workspaces/<runId>/
```

Orchestrator는 “앱 개발/파일 수정/코드 구현”처럼 실제 산출물을 요구하는 요청을 implementation으로 분류하고, workspace 변경 파일과 검증 결과가 없으면 complete로 처리하지 않는다.

완료/중단 run 삭제 시 `.agentboard/runs/<runId>/`와 `.agentboard/workspaces/<runId>/`는 함께 삭제된다. Workspace preview API는 workspace 내부 상대 경로만 허용하며 `../` 같은 path traversal 요청은 거부한다.

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
