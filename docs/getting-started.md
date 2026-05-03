# Getting Started

## 목적

처음 사용하는 사람이 AgentBoard MVP를 빠르게 실행하고, ChatGPT형 요청/응답, 에이전트 간 메시징, 사용자 관찰, 진행 중 취소 흐름을 확인하는 방법을 설명한다.

## 전제 조건

권장 환경:

- Node.js 20.9 이상
- npm
- macOS/Linux 권장

Mock mode는 외부 key 또는 Codex CLI 없이 실행되어야 한다.
따라서 기본 mock demo만 확인할 때는 `.env.local`을 만들 필요가 없다.

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

1. `/` 페이지에서 좌측 세션 목록과 중앙 챗봇 composer를 확인한다.
2. 중앙 composer에 첫 요청을 입력한다.

   ```text
   여러 AI 에이전트가 협업하는 Chat MVP 계획을 만들어줘.
   ```

3. 실행 모드는 `mock`을 선택한다.
4. `전송` 버튼을 누른다.
5. 새 run이 좌측 세션 목록에 추가되고 중앙 채팅 영역에서 선택되는지 확인한다.
6. 4분할 Agent 채팅 패널과 `Logs` 버튼에서 다음 흐름을 확인하고, log 항목을 눌러 전체 payload를 팝업으로 확인한다. Logs 필터로 Agent 전달, 권한 요청, 오류/timeout, tmux session 이벤트만 좁혀볼 수 있다.
   - `run.started`
   - `orchestrator -> agent` 업무 배정 메시지
   - 필요한 경우 `planner -> engineer` 또는 `engineer -> reviewer` handoff 메시지
   - 필요한 경우 `reviewer -> orchestrator` 품질 검토 메시지
   - `artifact.updated`
7. Orchestrator/Planner/Engineer/Reviewer 패널에서 각 Agent의 상태, 최근 메시지, 최근 이벤트를 확인한다.
8. 답변 생성 중 하단 입력창이 계속 활성화되고 `개입 보내기`, `현재 작업 취소` 버튼이 보이는지 확인한다.
9. 진행 중 `모바일 조건도 추가해줘` 같은 추가 지시를 보내 Orchestrator 패널과 Logs에 개입 판단이 남는지 확인한다.
10. 답변이 완료되면 `산출물` 버튼에서 Final Report, Messages, Workspace 탭을 확인한다.
11. 같은 입력창에 다음 질문을 보내 Orchestrator → User 최종 답변이 추가되는지 확인한다.
12. 취소 테스트가 필요하면 `현재 작업 취소`를 눌러 status가 `stopped`로 바뀌는지 확인한다.

## Session resume 확인

1. 첫 실행 시 브라우저가 session id를 자동 생성한다.
2. run을 만든 뒤 좌측 세션 목록에 대화가 표시되는지 확인한다.
3. `새 대화`를 눌러 빈 composer로 전환한 뒤 다른 메시지를 보내 새 run을 만든다.
4. 좌측 목록에서 기존 run과 새 run을 번갈아 선택해 메시지/로그/실행 요약이 전환되는지 확인한다.
5. 완료되었거나 중단된 run의 `삭제` 버튼을 눌러 좌측 목록에서 제거되는지 확인한다.
6. ChatRoom에서 선택 agent, Logs/실행 요약 표시 상태 같은 run별 UI 상태가 새로고침 뒤에도 유지되는지 확인한다.
7. dev server를 재시작한 뒤 오래된 `running` run이 있으면 resume snapshot에서 stale 상태로 안전하게 표시되는지 확인한다.

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
.agentboard/workspaces/<runId>/
  implementation 산출물
.agentboard/runs/_sessions/<clientSessionId>.json
```

`.agentboard/`는 `.gitignore` 대상이다.

## Optional CLI mode

실제 AI CLI 연동은 기본 실행 경로가 아니다. 로컬에 Codex와 tmux가 있고 환경변수를 설정한 뒤 사용한다. 실제 시연은 `tmux-codex`를 권장한다.

먼저 예시 파일을 로컬 설정으로 복사한다. `.env.local`은 `.gitignore` 대상이다.

```bash
cp .env.example .env.local
```

복사한 `.env.local`에서 `AGENTBOARD_MODE=cli`와 Codex/tmux 값을 설정한다.

권장 예시:

```bash
AGENTBOARD_MODE=cli
AGENTBOARD_CODEX_CMD="codex --no-alt-screen"
AGENTBOARD_ORCHESTRATOR_ADAPTER=tmux-codex
AGENTBOARD_PLANNER_ADAPTER=tmux-codex
AGENTBOARD_ENGINEER_ADAPTER=tmux-codex
AGENTBOARD_REVIEWER_ADAPTER=tmux-codex
```

설정을 저장한 뒤 서버를 실행한다.

```bash
npm run dev
```

role별 adapter 환경변수를 생략하면 기본값은 모두 `tmux-codex`다.
AgentBoard가 저장된 메시지 이력을 다음 Agent prompt context로 주입하므로, Codex stdout이나 tmux pane output은 adapter 출력이고 실제 대화 이력은 `.agentboard` state에 남는다. CLI mode가 실패해도 mock mode는 계속 동작해야 한다.

`codex exec` one-shot 설정은 짧은 smoke 검증용 fallback이다. 긴 작업, 권한 요청, 완료 감지가 중요한 시연에는 `tmux-codex`를 사용한다.

## 성공 기준

처음 실행한 사람이 아래를 확인하면 성공이다.

- 4분할 Agent 채팅 패널에서 2개 이상의 agent가 보인다.
- 각 Agent 패널에서 현재 상태, 최근 활동, session 상태가 보인다.
- Agent 간 메시지 전달 과정이 각 Agent 패널과 Logs drawer에 표시된다.
- `tmux-codex` 권한 요청이 발생하면 해당 Agent 메시지 feed 하단 부근에 승인/거절 카드가 표시된다.
- 상단 `승인 요청` badge를 누르면 pending 요청이 있는 Agent 확대 화면으로 바로 이동한다.
- 완료/중단된 대화를 좌측 세션 목록에서 삭제할 수 있다.
- 답변 생성 중에도 추가 지시를 보낼 수 있고 Orchestrator가 개입 처리 방식을 판단한다.
- 실제 구현 요청은 workspace 변경 파일과 검증 결과가 있어야 완료 처리된다.
- `산출물` 패널에서 final-report, messages timeline, workspace 파일 목록/preview를 확인할 수 있다.
- 진행 중에는 별도 `현재 작업 취소` 버튼으로 즉시 중단할 수 있다.
- 답변 완료 뒤 같은 채팅방에서 다음 요청을 보낼 수 있다.
- 취소하면 run이 `stopped` 상태로 바뀌고 다시 요청을 보낼 수 있다.
- Logs 안에서 실행 요약 artifact를 열 수 있고, 상단 `산출물` 버튼에서도 같은 결과를 볼 수 있다.
