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

### Integration test

여러 모듈이 함께 동작하는지 검증한다.

대상:

- `POST /api/runs`가 run directory를 만들고 runner를 시작하는지
- Message Bus가 `messages.jsonl`과 target inbox에 동시에 기록하는지
- Intervention API가 user message를 생성하고 agent inbox로 라우팅하는지
- Artifact writer가 최종 Markdown을 갱신하는지
- Client session store가 active/recent run을 기록하고 stale run을 안전하게 표시하는지

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
4. Mock runner integration test
5. Intervention API가 완료된 run에서 새 답변 turn을 시작하는지 검증
6. Control stop API와 runner cancellation test
7. CLI adapter command parsing / fake CLI integration test
8. Session persistence store/API test
9. Chat UI state persistence smoke test
10. Firebase adapter test는 optional

## 테스트 작성 규칙

- Mock mode를 기준으로 먼저 작성한다.
- 외부 Firebase 또는 실제 Codex CLI 의존 테스트는 기본 CI/로컬 테스트에서 제외한다.
- 파일 시스템 테스트는 임시 디렉터리를 사용한다.
- 테스트가 생성한 `.agentboard` state는 테스트 종료 후 삭제한다.
- 시간/ID가 필요한 경우 deterministic helper를 주입한다.
- “성공했다”는 UI 문구보다 event/message/artifact 파일을 함께 검증한다.
- Codex stdout 자체보다 AgentBoard runtime이 만든 context, handoff message, Reviewer user 답변을 검증한다.
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
    from: 'reviewer',
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
- [ ] 2개 이상 agent 표시
- [ ] agent-agent message 표시
- [ ] 진행 중 composer가 잠기고 취소 버튼 표시
- [ ] 완료 뒤 다음 요청 전송 가능
- [ ] 취소 시 `control.stopped` event와 `stopped` status 기록
- [ ] final artifact 표시
- [ ] 루트 페이지에서 active/recent run resume 가능
- [ ] ChatRoom 새로고침 뒤 선택 agent, Logs/보고서 drawer, draft 복원
- [ ] 오래된 running run이 stale로 표시되고 기록 조회 가능
- [ ] `.agentboard/`가 gitignore됨

## 테스트 명령 예시

프로젝트 스크립트가 생기면 아래 명령을 기준으로 맞춘다.

```bash
npm run typecheck
npm test
npm run build
```

E2E가 아직 없으면 수동 QA checklist를 기준으로 검증한다.
