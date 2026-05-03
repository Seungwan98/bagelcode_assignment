# Web 기반 멀티 에이전트 협업 도구 계획

## 1. 목표와 제출 관점

베이글코드 모바일 캐주얼팀 과제 제출용으로, **여러 AI 에이전트가 하나의 과제를 분담하고 사용자가 웹 화면에서 진행 상황을 관찰·개입할 수 있는 협업 도구**를 제안한다. 구현은 거대한 자동화 플랫폼보다 “실제로 3~5일 안에 데모 가능한 관리형 멀티 에이전트 워크스페이스”에 집중한다.

- 핵심 사용자: PM/개발자/기획자가 과제를 입력하고, Planner·Researcher·Coder·Reviewer 에이전트의 협업을 감시하는 사람
- 핵심 가치: CLI 로그를 몰라도 브라우저에서 작업 분해, 에이전트 상태, 메시지, 산출물, 승인/중단을 한눈에 본다.
- 범위: Web UI + 실시간 이벤트 + 간단한 Agent Runner + 메시지/상태 저장소

## 2. 과제 조건 충족 방식

| 요구 | Web 도구 계획 |
| --- | --- |
| 멀티 에이전트 협업 | 작업을 `Task -> Subtask -> AgentRun`으로 분해하고 역할별 에이전트가 병렬/순차 실행된다. |
| 사용자 관찰 | 대시보드에서 에이전트별 상태, 현재 생각/행동 요약, 로그 스트림, 산출물 diff를 실시간 표시한다. |
| 사용자 개입 | 승인 게이트, 에이전트 일시정지/재개, 추가 지시, 특정 메시지 재전송, 산출물 채택/거절을 제공한다. |
| 에이전트 간 메시징 | 모든 통신을 append-only event log로 저장하고 WebSocket/SSE로 UI에 전파한다. |
| 제출 실용성 | 로컬 실행 가능한 README, seed demo scenario, 3~5일 MVP 범위, 리스크와 확장 계획을 포함한다. |

## 3. 사용자 관찰/개입 UX 설계

### 3.1 화면 구성

1. **Workspace Dashboard**
   - 과제 입력, 목표/제약/마감 설정
   - 전체 진행률: planning / executing / reviewing / blocked / done
   - Agent 카드: 역할, 상태, 마지막 액션, 토큰/시간 비용, 산출물 링크

2. **Timeline / Event Feed**
   - 모바일 캐주얼팀 데모 시나리오: 7일 출석 이벤트 개선, 신규 유저 D1 리텐션 가설, 퍼즐 스테이지 난이도 리뷰
   - `task.created`, `agent.started`, `message.sent`, `artifact.updated`, `approval.requested`, `task.completed` 이벤트를 시간순으로 표시
   - 실패 이벤트는 빨간 배지와 재시도 버튼 제공

3. **Agent Conversation Matrix**
   - 행: 에이전트, 열: 메시지 스레드/작업
   - 누가 누구에게 어떤 요청을 보냈는지 시각화
   - 사용자가 특정 메시지에 “clarify”, “override”, “stop” 코멘트를 삽입 가능

4. **Artifact Review Panel**
   - 산출물 markdown/code/diff를 웹에서 미리보기
   - “승인 후 다음 단계 진행”, “수정 요청”, “이 버전 고정” 버튼 제공

5. **Intervention Queue**
   - 에이전트가 확신 부족, 권한 필요, 충돌 감지 시 사용자에게 질문
   - 사용자는 답변 또는 정책 선택지로 흐름을 제어

### 3.2 관찰/개입 UX 원칙

- 기본은 자동 진행, 개입은 **게이트가 있는 위험 지점**에만 요구한다.
- 로그 원문보다 “현재 무엇을 하고 있고 무엇이 막혔는지”를 우선 보여준다.
- 에이전트 메시지는 삭제하지 않고 append-only로 남겨 재현성을 확보한다.
- 사용자의 개입도 동일한 이벤트로 저장해 이후 실행 근거가 되게 한다.
- 판단 근거, 반대 의견, 확신도를 함께 노출해 “블랙박스 자동화”로 보이지 않게 한다.

## 4. 에이전트 간 메시징 프로토콜

### 4.1 핵심 엔티티

```text
Workspace(id, title, goal, constraints, status)
Task(id, workspace_id, title, owner_agent, status, depends_on[])
Agent(id, role, model, tools, status)
Message(id, workspace_id, from, to, type, intent, payload, confidence, requires_human_approval, correlation_id, created_at)
Event(id, workspace_id, type, payload, idempotency_key, retry_count, visibility, created_at)
Artifact(id, workspace_id, task_id, path, version, content_hash)
Approval(id, task_id, requested_by, status, decision_note)
```

### 4.2 메시지 타입

| type | 용도 | 예시 |
| --- | --- | --- |
| `TASK_ASSIGN` | 리더가 에이전트에게 작업 배정 | Planner에게 요구사항 정리 요청 |
| `PROPOSAL` | 전문 에이전트의 제안 | Analyst가 D1 리텐션 가설 제안 |
| `CRITIQUE` | 다른 에이전트의 반박/검토 | QA가 이벤트 악용 가능성 지적 |
| `STATUS_UPDATE` | 진행 상태 알림 | “Researcher 70%, 자료 3개 확인” |
| `HANDOFF` | 결과와 다음 역할 전달 | Researcher -> Coder 요약 전달 |
| `BLOCKED` | 권한/정보/충돌로 중단 | “API key 필요”, “파일 충돌” |
| `ARTIFACT_PROPOSED` | 산출물 생성/수정 알림 | plan.md v2 제출 |
| `USER_OVERRIDE` | 사용자 개입 | “리스크 섹션을 줄이고 README를 강화” |
| `APPROVAL_REQUESTED` | 게이트 대기 | “코드 실행 전 승인 필요” |
| `TERMINATE` | 중단/취소 | 특정 AgentRun 종료 |

### 4.3 전송/저장 흐름

1. Agent Runner가 메시지를 DB에 저장한다.
2. 저장 성공 후 Event Bus가 `message.sent` 이벤트를 발행한다.
3. WebSocket/SSE 채널이 workspace room 구독자에게 이벤트를 push한다.
4. UI는 optimistic update 대신 서버 이벤트를 기준으로 상태를 갱신한다.
5. 재시도 가능성을 위해 모든 AgentRun은 `correlation_id`로 추적한다.

### 4.4 충돌 처리

- 같은 artifact를 두 에이전트가 수정하면 `artifact.lock.requested` 이벤트를 생성한다.
- 리더 에이전트 또는 사용자가 winner를 정한다.
- 병합 불가 시 Reviewer 에이전트가 conflict summary를 만들고 사용자 승인 큐로 보낸다.

## 5. 추천 기술스택

### 5.1 MVP 권장안: TypeScript 중심 Web Stack

- **Frontend/Backend shell:** Next.js App Router + TypeScript
  - 대시보드, API route, 서버 액션/라우트 핸들러를 한 프로젝트에서 빠르게 구성
  - 공식 문서 기준 App Router는 React Server Components, Suspense, Server Functions를 활용한다.
- **Realtime:** Socket.IO, native WebSocket/SSE, 또는 Supabase Realtime
  - workspace room 단위 broadcast가 필요하면 Socket.IO rooms가 단순하다.
  - 단방향 이벤트 스트림 위주면 SSE로 시작해도 충분하다.
- **DB:** PostgreSQL + Prisma
  - append-only event/message/artifact metadata를 관계형으로 관리
- **Queue/Worker:** BullMQ + Redis Streams 또는 간단한 in-process worker
  - 3~5일 MVP는 in-process worker로 시작, 데모 이후 Redis queue로 전환
- **Agent orchestration:** LangGraph JS 또는 자체 lightweight state machine
  - 장시간/상태ful/human-in-the-loop 요구가 커지면 LangGraph 채택
  - 과제 MVP는 직접 `AgentRun` 상태머신을 만들고 LangGraph는 optional adapter로 둔다.
- **UI:** Tailwind CSS + shadcn/ui + React Flow(optional)
  - 빠른 구현과 에이전트 그래프 시각화에 유리
- **Testing:** Vitest + Playwright
  - 메시지 reducer/unit, workspace happy path e2e 검증

### 5.2 대안: Python Runner 분리형

- Web: Next.js
- Agent backend: FastAPI + WebSocket + Python agent libraries
- 장점: Python LLM 생태계 활용이 쉽다.
- 단점: 과제 기간 3~5일 기준으로 배포/통신/타입 경계가 늘어난다.
- 결론: **MVP는 TypeScript 단일 repo**, Python은 확장안으로 제시한다.

## 6. MVP 기능

### Must-have

1. 과제 생성: 목표, 제약, 에이전트 역할 선택
2. 자동 작업 분해: Leader가 subtasks 생성
3. Agent Runner mock/real 모드
   - mock: deterministic demo 응답
   - real: LLM provider adapter 연결
4. 실시간 Agent 상태판
5. 에이전트 간 메시지 feed
6. 사용자 개입: pause/resume, instruction inject, approval gate
7. 산출물 저장 및 markdown preview
8. README 기반 로컬 실행 + seed demo

### Nice-to-have

- React Flow로 에이전트 그래프 시각화
- artifact diff viewer
- 토큰/비용 estimate
- run replay 기능
- Slack/Discord 알림

### 제외 범위

- 완전한 권한/조직 관리
- 복잡한 코드 실행 sandbox
- 장기 메모리/RAG 고도화
- 프로덕션 멀티테넌시

## 7. README 실행 흐름

```bash
# 1. 설치
pnpm install

# 2. 환경변수
cp .env.example .env.local
# DATABASE_URL, REDIS_URL(optional), LLM_API_KEY(optional) 설정

# 3. DB 준비
pnpm prisma migrate dev
pnpm prisma db seed

# 4. 개발 서버 실행
pnpm dev

# 5. 브라우저 접속
open http://localhost:3000

# 6. 데모 시나리오
# - “신규 게임 이벤트 기획안 작성” seed workspace 선택
# - Run agents 클릭
# - Planner/Researcher/Reviewer 상태와 메시지 feed 관찰
# - Approval Queue에서 Reviewer handoff 승인
# - 최종 artifact preview 확인
```

README에는 “mock mode로 API key 없이 평가 가능”을 반드시 포함한다. 과제 채점자가 5분 안에 핵심 UX를 확인할 수 있어야 한다.

## 8. 3~5일 구현 범위

### Day 1: Skeleton + 데이터 모델

- Next.js 프로젝트 생성, Tailwind/shadcn 설정
- Prisma schema: Workspace, Task, AgentRun, Message, Event, Artifact
- seed demo data
- Dashboard 레이아웃

### Day 2: 실시간 이벤트와 메시징

- Event append API
- WebSocket/SSE 연결
- Timeline feed와 Agent cards 실시간 갱신
- mock Agent Runner 구현

### Day 3: 오케스트레이션 MVP

- Leader -> Worker task assignment 상태머신
- Agent role prompt/mock response
- handoff, blocked, approval_requested 이벤트
- Artifact markdown 생성/preview

### Day 4: 사용자 개입 UX

- pause/resume/terminate
- user instruction inject
- approval queue
- conflict/blocker display
- Playwright happy path 테스트

### Day 5: 제출 완성도

- README, architecture diagram, demo script
- 실패/재시도 케이스 정리
- UI polish, empty/loading/error states
- 짧은 녹화 또는 screenshot 첨부

## 9. 장점과 리스크

### 장점

- CLI 친숙도가 낮은 팀원도 멀티 에이전트 진행을 관찰할 수 있다.
- append-only event log로 실행 근거와 디버깅 경로가 명확하다.
- mock mode로 평가자가 API key 없이 과제 핵심을 확인할 수 있다.
- WebSocket/SSE 기반이라 에이전트 진행 상황을 실시간 데모하기 쉽다.
- 단일 TypeScript stack으로 3~5일 구현 가능성이 높다.

### 리스크 / 대응

| 리스크 | 영향 | 대응 |
| --- | --- | --- |
| LLM 응답 지연/실패 | 데모 중 흐름 끊김 | mock mode와 retry event 제공 |
| 실시간 상태 복잡도 | UI/DB 상태 불일치 | 서버 event log를 단일 진실원으로 사용 |
| 에이전트 폭주/루프 | 비용/시간 증가 | max steps, timeout, user approval gate |
| 범위 과다 | 제출 완성도 저하 | Day 3까지 핵심 demo path 고정, Day 4~5 polish |
| 보안/API key 노출 | 평가 환경 위험 | `.env.local`, server-only adapter, 로그 masking |

## 10. 제출 산출물 구조

```text
README.md
ARCHITECTURE.md
app/
  page.tsx                    # Dashboard
  workspace/[id]/page.tsx      # Run view
  api/events/route.ts
  api/runs/route.ts
components/
  AgentCard.tsx
  Timeline.tsx
  ApprovalQueue.tsx
  ArtifactPreview.tsx
lib/
  agent-runner.ts
  event-store.ts
  message-protocol.ts
  mock-agents.ts
prisma/schema.prisma
tests/e2e/demo.spec.ts
```

## 11. 검증 계획

- Unit: message reducer, event-store append ordering, AgentRun state transition
- Integration: task assignment -> message -> artifact -> approval flow
- E2E: seed workspace에서 Run agents 클릭 후 최종 artifact 표시까지
- Manual demo: API key 없는 mock mode와 API key 있는 real mode 각각 확인

## 12. 참고 근거

- Next.js App Router 공식 문서: App Router는 React Server Components, Suspense, Server Functions를 사용하는 파일 기반 라우터이며 최신 문서 기준 16.2.2가 표시됨. https://nextjs.org/docs/app
- FastAPI WebSocket 공식 문서: WebSocket endpoint에서 accept 후 text/binary/JSON 송수신 가능. https://fastapi.tiangolo.com/advanced/websockets/
- Socket.IO Rooms 공식 문서: room은 socket이 join/leave할 수 있는 서버 측 채널이며 일부 클라이언트 broadcast에 사용 가능. https://socket.io/docs/v4/rooms/
- LangGraph 공식 문서: durable execution, streaming, human-in-the-loop, memory, debugging을 agent orchestration 핵심 기능으로 제공. https://docs.langchain.com/oss/javascript/langgraph/overview
- Supabase Realtime 공식 문서: Broadcast, Presence, Postgres Changes로 연결된 클라이언트에 실시간 메시지/상태/DB 변경을 전달할 수 있음. https://supabase.com/docs/guides/realtime
- Redis Streams 공식 문서: XREAD, XREADGROUP, XRANGE 등 여러 소비 전략을 지원해 중요한 agent event queue의 확장안으로 적합. https://redis.io/docs/latest/develop/data-types/streams/

## 13. 최종 권고

제출용으로는 **Next.js 단일 Web 앱 + append-only event log + mock Agent Runner + 실시간 timeline** 조합이 가장 안전하다. 복잡한 실제 에이전트 프레임워크보다, 사용자가 협업 과정을 관찰하고 개입하는 UX를 선명하게 보여주는 것이 과제 평가에서 더 설득력 있다.
