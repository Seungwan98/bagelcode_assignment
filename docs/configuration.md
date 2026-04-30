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

현재 실제 CLI adapter는 Codex만 사용한다. `AGENTBOARD_MODE=cli` 또는 Chat UI에서 `cli` mode를 선택하면 Planner, Engineer, Reviewer가 모두 같은 Codex 명령을 역할별 prompt와 함께 한 번씩 실행한다. Codex stdout은 직접 Agent 간 통신이 아니라 AgentBoard session runtime이 message로 저장하고 다음 Agent prompt context에 주입하는 adapter 출력이다.

```bash
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
