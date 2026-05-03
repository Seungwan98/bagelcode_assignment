# 베이글코드 모바일 캐주얼팀 과제 계획: tmux 기반 CLI 멀티 에이전트 협업 도구

## 1. 목표와 범위

이 계획은 **worker-2 범위**인 `tmux 기반 CLI 도구`에 집중한다. 목표는 과제 제출자가 로컬 터미널에서 여러 AI 에이전트를 동시에 실행하고, 사용자가 각 에이전트의 진행 상황을 관찰·개입하며, 산출물을 하나의 제출용 리포트로 모을 수 있는 MVP를 3~5일 안에 구현하는 것이다.

- 제품명 예시: `Bagel Agents CLI`
- 핵심 가치: 별도 서버 없이 로컬 CLI/tmux만으로 멀티 에이전트 협업 과정을 **눈으로 볼 수 있고**, **중간에 지시를 추가할 수 있으며**, **재현 가능한 로그와 결과물**을 남긴다.
- 제외 범위: Web 대시보드/브라우저 UI 설계는 worker-1 계획 범위로 둔다.

## 2. 과제 조건 충족 방식

| 과제 요구 | tmux CLI 계획의 충족 방식 |
| --- | --- |
| 멀티 에이전트 협업 | lead pane 1개 + worker pane N개를 tmux 세션으로 띄우고, task queue 기반으로 역할별 작업을 분배한다. |
| 사용자 관찰 | 사용자는 `tmux attach -t <team>` 또는 `bagel team watch`로 모든 에이전트 pane, 상태 HUD, 이벤트 로그를 실시간 확인한다. |
| 사용자 개입 | `bagel team send --to worker-2 "..."`, `bagel task reassign`, `bagel team pause/resume/cancel`로 실행 중 지시를 주입한다. |
| 에이전트 간 메시징 | `.bagel/state/<team>/mailbox/*.jsonl` 또는 SQLite message table을 통해 send/ack/deliver 프로토콜을 제공한다. |
| 실행 가능 README | 설치, 환경 변수, 데모 태스크 실행, 관찰, 개입, 최종 리포트 export 흐름을 README에 그대로 넣는다. |
| 실전 제출 관점 | 과한 분산 시스템이 아니라 3~5일 내 시연 가능한 로컬 오케스트레이션 MVP로 제한한다. |

## 3. 사용자 관찰/개입 UX

### 3.1 기본 화면 구성

`bagel team start --workers 3 --task ./assignment.md` 실행 시 tmux 세션을 만든다.

```text
bagel-<run-id>
├─ 0:leader      # 작업 분해, 검토, 통합 리포트 작성
├─ 1:worker-1    # 예: Web 도구 계획
├─ 2:worker-2    # 예: tmux CLI 도구 계획
├─ 3:verifier    # 요구사항 충족/테스트 검증
└─ 4:hud         # 상태표, 이벤트 로그 tail, 사용자 명령 힌트
```

### 3.2 사용자가 보는 정보

- worker별 상태: `idle`, `claimed`, `in_progress`, `blocked`, `review`, `done`, `failed`
- 현재 task, 마지막 메시지, 마지막 파일 변경, 남은 deadline/lease
- 이벤트 로그: task claim, message send/deliver, verification pass/fail, export
- 비용/토큰은 MVP에서는 수동 입력 또는 에이전트 CLI 로그 요약으로 처리한다.

### 3.3 개입 명령 예시

```bash
# 특정 worker에게 추가 지시
bagel team send --to worker-2 "리스크 섹션에 tmux 의존성 완화책도 넣어줘"

# 전체 팀에 우선순위 변경 공지
bagel team broadcast "최종 보고는 한국어 1페이지 요약을 먼저 작성"

# 멈춤/재개/취소
bagel team pause
bagel team resume
bagel team cancel --reason "요구사항 변경"

# 작업 재배정
bagel task reassign 3 --to verifier
```

## 4. 에이전트 간 메시징 프로토콜

### 4.1 권장 저장 방식

MVP는 단순성과 디버깅성을 위해 **SQLite + JSONL 이벤트 로그 병행**을 권장한다.

- SQLite: task/message/status의 원자적 갱신, lease, 중복 처리
- JSONL: 사람이 보기 쉬운 감사 로그와 제출용 trace export
- 상태 root: `.bagel/state/<team-id>/`

### 4.2 핵심 데이터 구조

```json
{
  "message_id": "uuid",
  "team_id": "bagel-demo-001",
  "from": "leader",
  "to": "worker-2",
  "kind": "instruction|progress|question|result|ack|error",
  "task_id": "2",
  "body": "tmux CLI 계획의 README 실행 흐름을 보강해줘",
  "parent_message_id": null,
  "requires_ack": true,
  "created_at": "2026-04-30T09:00:00Z",
  "delivered_at": null,
  "acknowledged_at": null
}
```

### 4.3 task lifecycle

```text
pending -> claimed -> in_progress -> review -> completed
                         └────────-> blocked
                         └────────-> failed
```

- `claim`은 worker, lease token, 만료 시간을 함께 기록한다.
- lease가 만료되면 lead가 `pending`으로 되돌리거나 다른 worker에게 재배정한다.
- worker는 완료 시 `result`, `changed_files`, `verification`을 반드시 남긴다.

### 4.4 충돌 방지 규칙

- worker별 write scope를 task에 명시한다.
- 공용 파일 수정이 필요하면 `blocked`로 전환하고 lead 승인을 기다린다.
- 최종 통합은 lead만 수행한다.

## 5. 추천 기술 스택

### 5.1 MVP 스택

- Language: **TypeScript / Node.js 22 LTS**
- CLI: `commander` 또는 `clipanion`
- Validation: `zod`로 task/message schema 검증
- State: `better-sqlite3` 또는 Node 내장 `sqlite` 계열, JSONL event log 병행
- Process orchestration: macOS/Linux `tmux` CLI 래핑
- Rendering: MVP는 `console.table` + `tail -f`, 여유가 있으면 `ink` 기반 TUI
- Tests: `vitest` + temp directory 기반 integration test
- Packaging: `npm link` 또는 `npx bagel-agents`

### 5.2 선택 이유

- TypeScript는 CLI, schema, 테스트를 빠르게 묶기 좋고 README 재현성이 높다.
- tmux는 사용자가 에이전트별 stdout을 직접 볼 수 있어 과제 시연에 강하다.
- SQLite는 동시 claim/ack 같은 race condition을 JSON 파일보다 안전하게 처리한다.

### 5.3 대안

- Python + Typer + Rich + sqlite3도 가능하다.
- 단, 과제 제출용 빠른 시연에서는 Node/TypeScript가 README 설치 흐름과 테스트 자동화가 단순하다.

## 6. MVP 기능 목록

1. `bagel init`
   - `.bagel/config.json`, `.bagel/state/` 생성
   - agent command template 설정: 예: `codex --model ...`, `claude`, `gemini`
2. `bagel team start`
   - task markdown 입력을 받아 lead/worker/verifier tmux panes 생성
   - worker inbox와 task queue 생성
3. `bagel task claim / complete / fail`
   - lease 기반 task lifecycle 관리
4. `bagel team send / broadcast`
   - mailbox 메시지 전송, ack 상태 확인
5. `bagel team status / watch`
   - worker 상태, task 진행률, 최근 이벤트 표시
6. `bagel team pause / resume / cancel`
   - 사용자가 runaway 작업을 멈추고 회복 가능하게 함
7. `bagel report export`
   - 최종 산출물, 변경 파일, 이벤트 trace, 검증 결과를 Markdown으로 묶음
8. `bagel doctor`
   - tmux, node, model CLI, API key 존재 여부 점검

## 7. README 실행 흐름

README는 아래 순서로 사용자가 그대로 따라 할 수 있게 작성한다.

```bash
# 1) 설치
npm install
npm link
bagel doctor

# 2) 과제 입력 준비
cat > assignment.md <<'TASK'
베이글코드 모바일 캐주얼팀 과제용 멀티 에이전트 협업 도구 계획을 작성하라...
TASK

# 3) 팀 실행
bagel team start \
  --team bagel-assignment \
  --workers 2 \
  --task assignment.md \
  --agent-cmd "codex"

# 4) 실시간 관찰
tmux attach -t bagel-assignment
# 또는
bagel team watch --team bagel-assignment

# 5) 중간 개입
bagel team send --team bagel-assignment --to worker-2 \
  "tmux 기반 CLI 도구의 메시징 프로토콜을 더 구체화해줘"

# 6) 상태 확인과 결과 export
bagel team status --team bagel-assignment
bagel report export --team bagel-assignment --out report.md
```

README에 포함할 데모 시나리오:

- worker-1은 Web 기반 계획, worker-2는 tmux CLI 기반 계획 작성
- lead가 두 결과를 비교·통합
- verifier가 요구 섹션 누락 여부를 체크
- 사용자가 중간에 worker-2에게 리스크 보강 지시를 보내는 장면 캡처

## 8. 테스트/검증 계획

### 8.1 구현 시 자동 테스트

- Schema unit test
  - message/task/status JSON schema 유효성
  - 필수 필드 누락 시 실패
- Lifecycle unit test
  - `pending -> claimed -> in_progress -> completed`
  - 잘못된 전이 거부
  - lease 만료 후 재할당 가능
- Mailbox integration test
  - send-message가 수신자 mailbox에 기록됨
  - mark-delivered/ack가 중복 호출에도 idempotent
- tmux wrapper test
  - 실제 tmux 없이 fake executor로 pane 생성 명령 검증
  - CI에서는 fake, 로컬 smoke에서는 real tmux
- Report export test
  - task result, messages, verification evidence가 Markdown에 포함됨

### 8.2 과제 산출물 검증 체크리스트

- [ ] 과제 조건 충족 방식이 표로 명확히 매핑되어 있다.
- [ ] 사용자 관찰/개입 UX가 실제 CLI 명령 예시와 함께 설명되어 있다.
- [ ] 메시징 프로토콜에 schema, lifecycle, ack/lease 전략이 있다.
- [ ] 추천 기술 스택과 선택 이유가 있다.
- [ ] MVP 기능과 README 실행 흐름이 시연 가능하다.
- [ ] 장점/리스크와 완화책이 있다.
- [ ] 3~5일 구현 범위가 일자별로 현실적이다.

## 9. 장점과 리스크

### 장점

- **시연성이 높음**: tmux pane으로 에이전트들이 일하는 모습을 바로 보여줄 수 있다.
- **구현 범위가 작음**: 서버, 로그인, 배포 없이 로컬 CLI로 MVP 완성 가능하다.
- **개입이 직관적**: 사용자가 직접 pane을 보거나 CLI 명령으로 메시지를 보낼 수 있다.
- **재현 가능성**: state DB와 JSONL trace를 제출물에 첨부할 수 있다.
- **기존 CLI 에이전트 재사용**: Codex/Claude/Gemini 같은 CLI를 agent command로 감쌀 수 있다.

### 리스크와 완화책

| 리스크 | 영향 | 완화책 |
| --- | --- | --- |
| tmux 의존성 | Windows/비개발자 환경에서 실행 어려움 | macOS/Linux 우선 명시, `doctor` 제공, 추후 Web/pty 대안은 worker-1 계획과 연결 |
| 메시지 race condition | 중복 claim/누락 ack 가능 | SQLite transaction, lease token, idempotent ack 사용 |
| 에이전트 runaway | 비용/시간 증가 | pause/cancel, max-iteration, timeout, 사용자 개입 명령 제공 |
| 로그에 민감정보 노출 | API key/개인정보 유출 | env redaction, export 전 secret scan, `.bagelignore` 제공 |
| 최종 산출물 품질 편차 | 여러 worker 결과가 불균일 | lead 통합 단계와 verifier checklist를 강제 |
| tmux pane 상태 감지 실패 | 실제 프로세스 종료/멈춤 감지 어려움 | heartbeat file, process pid check, stale lease recovery |

## 10. 3~5일 구현 범위

### 3일 MVP 압축안

- Day 1: CLI skeleton, config/state directory, task/message schema, unit tests
- Day 2: tmux session/pane 생성, worker inbox 생성, send/status/watch MVP
- Day 3: lifecycle claim/complete, report export, README 데모, 로컬 smoke test

### 5일 안정화안 권장

- Day 1: 요구사항 정리, CLI command skeleton, SQLite schema, schema/lifecycle tests
- Day 2: tmux orchestrator, pane naming, agent command template, `doctor`
- Day 3: mailbox send/broadcast/ack, worker status, `watch` HUD
- Day 4: pause/resume/cancel, stale lease recovery, report export, secret redaction
- Day 5: README 데모 시나리오, real tmux smoke test, verifier checklist, 제출용 요약 작성

## 11. 제출용 요약 문구

`Bagel Agents CLI`는 로컬 tmux 세션을 멀티 에이전트 협업 공간으로 사용한다. 사용자는 각 에이전트 pane을 실시간으로 관찰하고, CLI 메시지로 중간 지시를 넣으며, 모든 task/message/verification 기록을 최종 Markdown 리포트로 export할 수 있다. Web 서비스보다 화려함은 덜하지만 3~5일 과제 범위에서 구현·시연·디버깅 가능성이 높고, 베이글코드 모바일 캐주얼팀 과제의 핵심인 멀티 에이전트 협업 과정의 투명성과 제어 가능성을 가장 빠르게 보여준다.

## 12. 완료 기준

- 이 문서가 `.omx/plans/tmux-cli-multi-agent-tool-plan.md`에 저장되어 있다.
- 요구된 8개 항목이 모두 포함되어 있다: 조건 충족, 관찰/개입 UX, 메시징, 기술스택, MVP, README, 장점/리스크, 3~5일 범위.
- 한국어로 간결하고 실전적인 제출 관점의 설명을 제공한다.
- 별도 코드 변경 없이 계획 문서만 추가한다.
