# Getting Started

## 목적

처음 사용하는 사람이 AgentBoard MVP를 빠르게 실행하고, 과제 핵심 조건인 에이전트 간 메시징과 사용자 관찰/개입을 확인하는 방법을 설명한다.

## 전제 조건

권장 환경:

- Node.js 20.9 이상
- npm
- macOS/Linux 권장

Mock mode는 Firebase key 또는 Codex CLI 없이 실행되어야 한다.

## 설치

프로젝트가 생성된 뒤 기본 설치 명령은 다음 형태를 따른다.

```bash
npm install
```

## 개발 서버 실행

```bash
npm run dev
```

브라우저에서 접속한다.

```text
http://localhost:3000
```

## 첫 실행 시나리오

1. `/` 페이지에서 채팅 시작 composer를 연다.
2. 과제 brief를 입력한다.

   ```text
   여러 AI 에이전트가 협업하는 Chat MVP 계획을 만들어줘.
   ```

3. 실행 모드는 `mock`을 선택한다.
4. `대화 시작` 버튼을 누른다.
5. `/runs/<runId>` 채팅방으로 이동한다.
6. 상단 우측 `Logs` 버튼에서 다음 흐름을 확인하고, 로그 항목을 눌러 전체 payload를 팝업으로 확인한다.
   - `run.started`
   - `planner -> engineer` 메시지
   - `engineer -> planner` progress/result 메시지
   - `reviewer` 검토 메시지
   - `artifact.updated`
7. 상단 agent rail에서 agent를 눌러 현재 상태, 최근 메시지, 최근 이벤트를 확인한다.
8. 하단 채팅 입력창에 사용자 지시를 보낸다.

   ```text
   구현 범위를 ASAP MVP로 줄이고 README 실행성을 우선해줘.
   ```

9. 채팅방에서 전송 완료 상태를 확인하고, Logs에서 내부 수신 처리와 전달 이벤트를 확인한다.
10. 상단 `보고서 보기` 버튼을 눌러 최종 Markdown 결과가 사용자 지시를 반영했는지 확인한다.

## 예상 생성 파일

실행 중 local state가 생성된다.

```text
.agentboard/runs/<runId>/
  run.json
  state.json
  events.jsonl
  messages.jsonl
  agents/<agentId>/inbox.jsonl
  agents/user/inbox.jsonl
  artifacts/final-report.md
```

`.agentboard/`는 `.gitignore` 대상이다.

## Optional CLI mode

실제 AI CLI 연동은 기본 실행 경로가 아니다. 로컬에 CLI가 있고 환경변수를 설정한 뒤 사용한다.

예시:

```bash
AGENTBOARD_MODE=cli \
AGENTBOARD_PLANNER_ADAPTER=codex \
AGENTBOARD_ENGINEER_ADAPTER=codex \
AGENTBOARD_REVIEWER_ADAPTER=codex \
AGENTBOARD_CODEX_CMD="codex exec" \
AGENTBOARD_CLI_PROMPT_MODE=stdin \
npm run dev
```

현재 CLI mode는 세 역할이 모두 Codex를 사용한다. CLI mode가 실패해도 mock mode는 계속 동작해야 한다.

CLI가 prompt를 argument로 받는 경우:

```bash
AGENTBOARD_CLI_PROMPT_MODE=append-arg npm run dev
```

## Optional Firebase mode

Firebase는 선택 사항이다. 먼저 `configuration.md`를 보고 `.env.local` 또는 `config/firebase.local.json`을 준비한다.

Mock mode에서는 Firebase 설정이 없어도 된다.

## 성공 기준

처음 실행한 사람이 아래를 확인하면 성공이다.

- 채팅 상단 agent rail에서 2개 이상의 agent가 보인다.
- Agent를 클릭하면 해당 agent의 현재 상태와 최근 활동이 보인다.
- Agent 간 메시지 전달 과정이 Logs drawer에 표시된다.
- 사용자가 지시를 보낼 수 있다.
- Agent가 사용자 지시를 내부 기록 또는 결과에 반영한다.
- 최종 artifact를 볼 수 있다.
