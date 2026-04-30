# Extending AgentBoard

## 목적

AgentBoard에 새로운 agent, adapter, storage, UI 기능을 추가할 때 지켜야 할 구조와 확장 방법을 설명한다.

## 확장 원칙

- Mock mode를 깨지 않는다.
- Agent 간 메시징과 사용자 개입 흐름을 우회하지 않는다.
- 새 기능은 event log에 관찰 가능한 흔적을 남긴다.
- 실제 외부 서비스 연동은 optional adapter로 둔다.
- secret은 configuration 규칙을 따른다.

## 새 Agent role 추가

예: `researcher` agent 추가

1. `AgentRole` union에 role을 추가한다.
2. `AgentDefinition` registry에 표시 이름, description, system prompt, handoff target을 추가한다.
3. Agent Session Runtime의 실행 순서 또는 handoff 규칙을 확장한다.
4. Mock output과 CLI prompt context test를 추가한다.
5. Artifact에 해당 role의 기여가 표시되게 한다.

예상 메시지 흐름:

```text
planner -> researcher: 조사 요청
researcher -> planner: 조사 결과
planner -> engineer: 구현 방향 전달
```

## 새 Agent adapter 추가

Adapter는 공통 interface를 구현해야 한다.

```ts
interface AgentAdapter {
  id: string;
  start(ctx: AgentContext): Promise<void>;
  send(message: AgentMessage): Promise<void>;
  stop(): Promise<void>;
}
```

추가 절차:

1. adapter 파일 생성
2. config 값 정의
3. allowlist 또는 인증 정책 정의
4. stdout/stderr/event 변환 규칙 작성
5. stop cleanup 구현
6. mock mode 회귀 테스트 실행

## CLI adapter 확장

현재 구현된 `CliAgentAdapter`는 local command를 `spawn(..., { shell: false })`로 실행하고,
stdout을 Agent Session Runtime에 반환한다. Runtime이 stdout을 message로 저장하고 다음 Agent prompt context에 주입한다. `cli` run은 다음 순서로 진행한다.

```text
Planner CLI -> Engineer CLI -> Reviewer CLI -> final artifact
```

새 CLI를 붙일 때는 다음을 지킨다.

- 명령은 allowlist에 추가한다.
- `shell: false` 실행을 기본으로 한다.
- 사용자 입력을 shell command string에 직접 붙이지 않는다.
- CLI output은 adapter log와 AgentBoard structured message로 나눠 저장한다.
- 실패 시 `error` event를 남긴다.

추가 설정이 필요한 CLI는 command spec에 인자를 포함하거나 prompt mode를 바꾼다.

```bash
AGENTBOARD_CODEX_CMD="codex exec"
AGENTBOARD_CODEX_PROMPT_MODE=append-arg
```

## Firebase persistence 추가

Firebase는 local JSONL store의 대체제가 아니라 optional persistence adapter로 시작한다.

권장 순서:

1. `PersistenceAdapter` interface 정의
2. `FilePersistenceAdapter`를 기존 JSONL store 위에 래핑
3. `FirebasePersistenceAdapter` 추가
4. mock run이 file adapter로 계속 동작하는지 확인
5. Firebase mode 테스트는 별도 optional 테스트로 분리

예시 interface:

```ts
interface PersistenceAdapter {
  appendEvent(runId: string, event: RunEvent): Promise<void>;
  appendMessage(runId: string, message: AgentMessage): Promise<void>;
  readRun(runId: string): Promise<Run>;
  readEvents(runId: string): Promise<RunEvent[]>;
  writeArtifact(runId: string, artifact: Artifact, body: string): Promise<void>;
}
```

## UI 기능 추가

### Message graph

Agent 간 메시지를 graph로 보여주는 기능.

추가 위치:

- Event/message selector
- `MessageGraph` component
- Chat UI의 optional panel 또는 bubble

검증:

- 같은 `messages.jsonl` 데이터를 사용한다.
- graph가 없더라도 채팅 메시지는 계속 동작한다.

### Approval gate

사용자가 특정 단계에서 승인해야 다음 agent가 진행하는 기능.

추가 개념:

- `approval.requested` event
- `approval.approved` event
- `approval.rejected` event
- pending approval state

주의:

- approval도 user intervention의 특수 형태로 볼 수 있다.
- 승인 대기 중 run status를 명확히 표시한다.

## 새 API route 추가

추가 전 확인:

- 기존 route로 충분하지 않은가?
- event log에 어떤 event를 남기는가?
- 실패 응답 구조는 일관적인가?
- Chat UI에서 재시도 가능한가?

권장 에러 응답:

```json
{
  "ok": false,
  "error": {
    "code": "RUN_NOT_FOUND",
    "message": "Run을 찾을 수 없습니다."
  }
}
```

## 새 문서 추가 기준

새 문서는 다음 경우에만 추가한다.

- 기존 6개 문서 중 어디에도 자연스럽게 들어가지 않는다.
- 독립적으로 자주 참조된다.
- 구현자나 사용자에게 실질적인 실행 지침이 된다.

현재 기본 문서 구조:

```text
docs/architecture.md
docs/getting-started.md
docs/configuration.md
docs/test-writing-guide.md
docs/troubleshooting.md
docs/extending.md
```

## 확장 전 체크리스트

- [ ] Mock mode가 계속 동작한다.
- [ ] 새 기능이 event log에 기록된다.
- [ ] 사용자 개입 흐름을 우회하지 않는다.
- [ ] secret이 source에 들어가지 않는다.
- [ ] 테스트 또는 manual QA 항목이 추가됐다.
- [ ] docs가 최신 구조에 맞게 갱신됐다.
