# AgentBoard OMX session evidence

이 디렉터리는 BagelCode 과제 제출 시 AI coding agent 사용 과정과 멀티 에이전트 협업 로그를 함께 확인할 수 있도록 포함한다.

## 주요 위치

- `logs/` — OMX hook, turn, notification, team dispatch/delivery log
- `context/` — 작업 중 생성된 context snapshot
- `plans/` — Web dashboard MVP와 tmux CLI tool 계획/기술 명세
- `reports/team-commit-hygiene/` — team 실행 결과와 ledger
- `state/team/` — team mailbox, worker state, task 진행 상태
- `state/sessions/` — OMX session별 runtime 상태
- `skills/` — 프로젝트에 사용한 재사용 skill

## 포함한 이유

과제 조건의 “AI 코딩 에이전트를 사용하여 개발”했다는 증거와,
팀 기반 Agent 간 작업 분담/메시지 흐름을 평가자가 확인할 수 있게 하기 위함이다.

## 제외되는 항목

`.gitignore`는 `.omx/`를 의도적으로 허용하지만 다음 항목은 여전히 레포 밖에 둔다.

- `.env.local`
- service-account JSON
- 실제 API key 또는 private key
- `.agentboard/` 로컬 run store
- `node_modules/`, `.next/`, test output

Commit 전에는 secret scan을 실행한다.
