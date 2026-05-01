# Test Writing Guide

## 목적

AgentBoard MVP에서 중요한 것은 “ChatGPT형 사용자 요청/응답”, “에이전트 간 메시징”, “사용자 관찰”, “진행 중 취소”, “artifact 생성”이 깨지지 않는 것이다. 테스트는 이 증거를 보호하는 방향으로 작성한다.

## 테스트 계층

### Unit test

작은 순수 로직을 검증한다.

대상:

- JSONL append/read utility
- message id 생성
- message validation
- event type validation
- state reducer
- adapter command allowlist
- orchestrator plan parsing과 fallback role 선택
- prompt builder의 context 조립

### Integration test

여러 모듈이 함께 동작하는지 검증한다.

대상:

- `POST /api/runs`가 run directory를 만들고 runner를 시작하는지
- Message Bus가 `messages.jsonl`과 target inbox에 동시에 기록하는지
- Intervention API가 user message를 생성하고 agent inbox로 라우팅하는지
- Artifact writer가 최종 Markdown을 갱신하는지
- Client session store가 active/recent run을 기록하고 stale run을 안전하게 표시하는지
- Delete API가 완료/중단 run을 삭제하고 client session index에서 제거하는지
- Agent Session Runtime이 Orchestrator plan, prompt builder, message bus를 사용하는지
- Agent Session Runtime이 진행 중 사용자 개입을 checkpoint에서 Orchestrator decision으로 처리하는지
- `tmux-codex` adapter가 DONE marker, stable idle fallback, permission approval event를 올바르게 처리하는지

### E2E or smoke test

README 흐름이 실제로 되는지 검증한다.

대상:

- 앱 실행
- mock run 생성
- 채팅 메시지 업데이트 확인
- 진행 중 입력 잠금과 취소 확인
- 완료 뒤 다음 요청 전송과 새 agent 답변 확인
- final artifact 확인

## 우선순위

ASAP 구현에서는 아래 순서로 테스트를 추가한다.

1. Message Bus unit/integration test
2. JSONL store test
3. Agent Session Runtime context/handoff test
4. Orchestrator plan parser/fallback과 Prompt Builder test
5. Mock runner integration test
6. Intervention API가 완료된 run에서 새 답변 turn을 시작하는지 검증
7. Control stop API와 runner cancellation test
8. `tmux-codex` delayed DONE / idle fallback / approval approve-reject regression test
9. One-shot CLI adapter command parsing / fake CLI integration test
10. 진행 중 intervention queue와 Orchestrator continue/restart/ask_user decision test
11. Session persistence store/API test
12. Chat UI state persistence smoke test
13. Run delete store/API test
14. implementation 요청이 workspace 변경 파일과 검증 증거 없이는 complete되지 않는 regression test

## 테스트 작성 규칙

- Mock mode를 기준으로 먼저 작성한다.
- 실제 Codex CLI 의존 테스트는 기본 CI/로컬 테스트에서 제외한다.
- 파일 시스템 테스트는 임시 디렉터리를 사용한다.
- 테스트가 생성한 `.agentboard` state는 테스트 종료 후 삭제한다.
- 시간/ID가 필요한 경우 deterministic helper를 주입한다.
- “성공했다”는 UI 문구보다 event/message/artifact 파일을 함께 검증한다.
- “구현 완료”는 텍스트 답변만 보지 말고 workspace 파일 증거와 commandsRun/testResults를 함께 검증한다.
- Codex stdout 자체보다 AgentBoard runtime이 만든 context, handoff message, Orchestrator user 답변을 검증한다.
- Runtime 순서 변경은 Orchestrator plan parser와 fallback strategy 테스트로 먼저 고정한다.
- Prompt 문구 변경은 stdout snapshot보다 필수 context section 존재 여부를 검증한다.
- Browser localStorage 기반 UI state는 서버 audit state와 분리해 테스트한다.

## 예시: JSONL store test

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, readJsonl } from '@/lib/utils/jsonl';

it('appends and reads JSONL records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-'));
  const file = join(dir, 'events.jsonl');

  await appendJsonl(file, { id: 'evt_1', type: 'run.created' });
  await appendJsonl(file, { id: 'evt_2', type: 'run.started' });

  await expect(readJsonl(file)).resolves.toEqual([
    { id: 'evt_1', type: 'run.created' },
    { id: 'evt_2', type: 'run.started' },
  ]);

  await rm(dir, { recursive: true, force: true });
});
```

## 예시: Message Bus test

```ts
it('routes planner instruction to engineer inbox', async () => {
  const bus = createMessageBus({ runDir, now, id });

  const message = await bus.send({
    runId: 'run_1',
    from: 'planner',
    to: 'engineer',
    kind: 'instruction',
    body: 'MVP 구조를 작성해줘',
  });

  expect(message.id).toBe('msg_1');
  await expect(readJsonl(`${runDir}/messages.jsonl`)).resolves.toContainEqual(message);
  await expect(readJsonl(`${runDir}/agents/engineer/inbox.jsonl`)).resolves.toContainEqual(message);
});
```

## 예시: 사용자 요청 turn test

```ts
it('persists user request and starts a new agent answer turn', async () => {
  const response = await postIntervention(runId, {
    to: 'all',
    body: 'README 실행성을 우선해 답해줘',
  });

  expect(response.ok).toBe(true);

  const messages = await readJsonl(`${runDir}/messages.jsonl`);
  expect(messages).toContainEqual(expect.objectContaining({
    from: 'user',
    to: 'all',
    kind: 'user_intervention',
    body: 'README 실행성을 우선해 답해줘',
  }));
  expect(messages).toContainEqual(expect.objectContaining({
    from: 'orchestrator',
    to: 'user',
    kind: 'result',
  }));
});
```

## Manual QA checklist

구현 뒤 수동으로 확인한다.

- [ ] `npm install` 성공
- [ ] `npm run dev` 성공
- [ ] mock run 생성 가능
- [ ] 루트 화면이 처음부터 챗봇 workspace로 표시됨
- [ ] 좌측 세션 목록에서 run 선택/새 대화 생성 가능
- [ ] 완료/중단된 run 삭제 가능
- [ ] 2개 이상 agent 표시
- [ ] agent-agent message 표시
- [ ] 4분할 Agent 채팅 패널에서 agent-agent message 확인 가능
- [ ] Logs drawer에서 handoff/raw event 확인 가능
- [ ] `tmux-codex` 권한 요청 카드 승인/거절 가능
- [ ] 진행 중 composer가 활성화되고 `개입 보내기`/`현재 작업 취소` 버튼 표시
- [ ] 진행 중 개입 전송 시 Logs에 `user.intervention_queued`, `intervention.decision_made` 표시
- [ ] 완료 뒤 다음 요청 전송 가능
- [ ] 취소 시 `control.stopped` event와 `stopped` status 기록
- [ ] Logs 내부 실행 요약 artifact 표시
- [ ] 루트 페이지 좌측 목록에서 active/recent run resume 가능
- [ ] ChatRoom 새로고침 뒤 선택 agent, Logs/실행 요약 표시 상태, draft 복원
- [ ] 오래된 running run이 stale로 표시되고 기록 조회 가능
- [ ] `.agentboard/`가 gitignore됨

## 테스트 명령 예시

프로젝트 스크립트가 생기면 아래 명령을 기준으로 맞춘다. 현재 `npm test`는 tmux 전역 mock 충돌을 피하기 위해 Node test runner를 `--test-concurrency=1`로 직렬 실행한다.

```bash
npm run typecheck
npm test
npm run build
```

E2E가 아직 없으면 수동 QA checklist를 기준으로 검증한다.
