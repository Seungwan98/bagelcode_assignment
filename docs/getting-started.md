# Getting Started

## 목적

처음 사용하는 사람이 AgentBoard MVP를 빠르게 실행하고, ChatGPT형 요청/응답, 에이전트 간 메시징, 사용자 관찰, 진행 중 취소 흐름을 확인하는 방법을 설명한다.

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

1. `/` 페이지에서 첫 요청 composer를 확인한다.
2. 과제 brief를 입력한다.

   ```text
   여러 AI 에이전트가 협업하는 Chat MVP 계획을 만들어줘.
   ```

3. 실행 모드는 `mock`을 선택한다.
4. `Agents에게 전송` 버튼을 누른다.
5. `/runs/<runId>` 채팅방으로 이동한다.
6. 상단 우측 `Logs` 버튼에서 다음 흐름을 확인하고, 로그 항목을 눌러 전체 payload를 팝업으로 확인한다.
   - `run.started`
   - `planner -> engineer` 메시지
   - `engineer -> planner` progress/result 메시지
   - `reviewer` 검토 메시지
   - `artifact.updated`
7. 상단 agent rail에서 agent를 눌러 현재 상태, 최근 메시지, 최근 이벤트를 확인한다.
8. 답변 생성 중 하단 입력창이 잠기고 현재 작업 indicator와 `취소` 버튼이 보이는지 확인한다.
9. 답변이 완료되면 같은 입력창에 다음 질문을 보내 Reviewer → User 답변이 추가되는지 확인한다.
10. 취소 테스트가 필요하면 `취소`를 눌러 status가 `stopped`로 바뀌는지 확인한다.

## Session resume 확인

1. 첫 실행 시 브라우저가 session id를 자동 생성한다.
2. run을 만든 뒤 `/`로 돌아간다.
3. 최근 run resume 카드가 표시되는지 확인한다.
4. resume 카드에서 기존 `/runs/<runId>`로 이동한다.
5. ChatRoom에서 선택 agent, Logs/보고서 drawer 같은 run별 UI 상태가 새로고침 뒤에도 유지되는지 확인한다.
6. dev server를 재시작한 뒤 오래된 `running` run이 있으면 resume snapshot에서 stale 상태로 안전하게 표시되는지 확인한다.

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
.agentboard/runs/_sessions/<clientSessionId>.json
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

현재 CLI mode는 세 역할이 모두 Codex를 사용한다. AgentBoard가 저장된 메시지 이력을 다음 Agent prompt context로 주입하므로, Codex stdout은 adapter 출력이고 실제 대화 이력은 `.agentboard` state에 남는다. CLI mode가 실패해도 mock mode는 계속 동작해야 한다.

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
- 답변 생성 중에는 추가 전송이 잠기고 취소 버튼이 보인다.
- 답변 완료 뒤 같은 채팅방에서 다음 요청을 보낼 수 있다.
- 취소하면 run이 `stopped` 상태로 바뀌고 다시 요청을 보낼 수 있다.
- 최종 artifact를 볼 수 있다.
