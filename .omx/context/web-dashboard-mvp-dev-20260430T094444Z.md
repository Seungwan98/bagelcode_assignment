# Web Dashboard MVP Development Context

## Task statement
Implement the AgentBoard Web Dashboard MVP based on current docs in /Users/seungwan/bagelcode. User explicitly requested `$team` coordinated execution.

## Desired outcome
A README-runnable Next.js/TypeScript app that demonstrates:
1. Two or more agents exchange structured messages.
2. User observes collaboration through dashboard timeline/status UI.
3. User intervenes during an active run.
4. Final artifact is generated and acknowledges user intervention.

## Current repo facts
- Project currently has docs/config only; no source app yet.
- Root docs structure: docs/architecture.md, docs/getting-started.md, docs/configuration.md, docs/test-writing-guide.md, docs/troubleshooting.md, docs/extending.md.
- Config templates: .env.example, config/firebase.example.json, config/firebase.local.json ignored.
- Commit convention: Korean-first `[Type] 한글 요약`.
- pnpm is not currently installed; npm and Node v22.22.2 are available.
- Firebase is optional; mock mode must work without Firebase keys.

## Constraints
- Use durable OMX team runtime; do not replace with in-process fanout.
- Keep mock mode as default and README-runnable.
- Avoid real secrets; do not commit local Firebase keys or .agentboard runtime state.
- No arbitrary shell interpolation in optional CLI adapter.
- Build ASAP vertical slice, not day-by-day plan.

## Likely code touchpoints
- package.json, tsconfig.json, next.config.ts, src/app/**, src/components/**, src/lib/**, tests/**, README.md, docs updates if implementation changes assumptions.

## External reference evidence
- Next.js App Router Route Handlers use `route.ts|js` files under `app/` and Web Request/Response APIs.
- MDN SSE/EventSource uses `text/event-stream` and EventSource for server-pushed browser updates.
- Node child_process.spawn is the official primitive for optional CLI adapter process execution.
