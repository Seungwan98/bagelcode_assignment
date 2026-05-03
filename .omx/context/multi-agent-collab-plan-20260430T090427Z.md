# Multi-Agent Collaboration Tool Plan Context

## Task statement
베이글코드 모바일 캐주얼팀 과제: Claude Code, Codex, Gemini CLI 등 둘 이상의 AI 코딩 에이전트가 서로 메시지를 주고받고, 사용자가 협업 과정을 관찰하거나 개입할 수 있는 도구를 설계/구현해야 한다. README대로 실행 가능해야 한다.

## Desired outcome
두 가지 구현 방향의 간단하지만 실현 가능한 계획:
1. Web 기반 멀티 에이전트 협업 도구
2. tmux 기반 CLI 도구

각 계획은 과제 조건 충족 방식, 핵심 기능, 아키텍처, 구현 범위, README 실행 시나리오, 장단점/리스크를 포함한다.

## Known facts/evidence
- 팀은 실제로 Claude Code, Codex, Gemini CLI 등 다양한 AI 에이전트를 동시에 사용한다.
- 핵심 평가는 에이전트 간 통신과 사용자의 관찰/개입 가능성이다.
- 최종 목표는 실제 PM/Engineer가 여러 에이전트를 통합해 제품 제작에 활용하는 경험에 가까운 도구일 가능성이 높다.
- 사용자는 Web, tmux based CLI Tool 두 방향의 계획을 원한다.

## Constraints
- 두 개 이상의 AI 에이전트가 메시지를 주고받아야 함.
- 사용자가 협업 과정에 개입하거나 관찰할 수 있어야 함.
- 통신 방식/프로토콜/UI/언어/프레임워크 자유.
- AI 코딩 에이전트를 사용하여 개발해야 함.
- README대로 실행 가능해야 함.
- 현재 단계는 구현 전 계획 수립.

## Unknowns/open questions
- 실제 외부 AI CLI 실행까지 필수인지, mock/adapter 기반 시연이 허용되는지 불명확.
- 평가자가 선호하는 UI 깊이 vs 안정성 균형 불명확.
- 배포/로컬 실행 환경 제약 불명확.

## Likely codebase touchpoints
아직 신규 프로젝트 또는 별도 디렉터리로 구현 가능. 계획 단계에서는 코드베이스 분석 불필요.
