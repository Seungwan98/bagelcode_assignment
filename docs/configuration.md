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

Optional real agent adapter용 명령이다. `AGENTBOARD_MODE=cli` 또는 Chat UI에서 `cli` mode를 선택하면
Planner, Engineer, Reviewer가 각자 매핑된 로컬 CLI 명령을 한 번씩 실행하고 출력 결과를 메시지로 전달한다.

```bash
AGENTBOARD_PLANNER_ADAPTER=codex
AGENTBOARD_ENGINEER_ADAPTER=claude
AGENTBOARD_REVIEWER_ADAPTER=gemini
AGENTBOARD_CODEX_CMD=codex
AGENTBOARD_CLAUDE_CMD=claude
AGENTBOARD_GEMINI_CMD=gemini
AGENTBOARD_CLI_PROMPT_MODE=stdin
AGENTBOARD_CLI_ALLOWLIST=codex,claude,gemini
AGENTBOARD_CLI_TIMEOUT_MS=120000
```

지원 adapter 값:

| 값 | 설명 |
| --- | --- |
| `codex` | `AGENTBOARD_CODEX_CMD`로 실행 |
| `claude` | `AGENTBOARD_CLAUDE_CMD`로 실행 |
| `gemini` | `AGENTBOARD_GEMINI_CMD`로 실행 |

prompt 전달 방식:

| 값 | 설명 |
| --- | --- |
| `stdin` | 기본값. prompt를 process stdin으로 전달 |
| `append-arg` | prompt를 마지막 CLI argument로 전달 |

CLI별 prompt mode override:

```bash
AGENTBOARD_CODEX_PROMPT_MODE=append-arg
AGENTBOARD_CLAUDE_PROMPT_MODE=append-arg
AGENTBOARD_GEMINI_PROMPT_MODE=append-arg
```

명령에 기본 옵션이 필요하면 quote로 감싼다.

```bash
AGENTBOARD_CLAUDE_CMD="claude -p"
AGENTBOARD_GEMINI_CMD="gemini -p"
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
```

`.agentboard/`는 commit하지 않는다.

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
