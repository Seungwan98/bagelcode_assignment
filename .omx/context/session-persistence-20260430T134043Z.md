# Session Persistence Context Snapshot

## Task statement
Implement AgentBoard session persistence using the approved plan: keep browser/user session identity, remember active/recent runs, restore prior conversations, persist lightweight ChatRoom UI state, and surface stale running runs safely.

## Desired outcome
- Browser gets/stores a `clientSessionId`.
- Runs can be associated with a client session.
- User can resume the latest active/recent run from the landing page.
- ChatRoom restores selected agent/log/report/target/draft UI state per run.
- Stale `running` runs are detectable and represented safely after server/process interruption.
- Existing mock/CLI runner, Logs drawer, report drawer, and Codex-only CLI behavior keep working.
- README/docs explain the session persistence behavior.

## Known facts/evidence
- Current stack: Next.js App Router + TypeScript.
- Current storage: local files/JSONL under `.agentboard/runs/<runId>/`.
- Current APIs: `/api/runs`, `/api/runs/:runId`, `/api/runs/:runId/events`, `/interventions`, `/control`, `/artifact` endpoints.
- Current UI: `RunCreateForm` on `/`, `ChatRoom` on `/runs/:runId`.
- Current logs/agent detail/report features are implemented in `src/components/ChatRoom.tsx`.
- Current type definitions live in `src/lib/protocol/types.ts`.
- Current store utilities live in `src/lib/store/file-store.ts`.

## Constraints
- No new dependencies unless necessary.
- Preserve README mock-mode execution.
- Keep Firebase optional.
- Keep existing `.agentboard/` ignored and local-only.
- Use Korean-first commit convention.
- Use OMX team runtime for coordinated execution and verify before shutdown.

## Unknowns/open questions
- Whether stale run should be a new RunStatus or a derived UI status. Prefer persisted `stale` status for clarity if type impact is small.
- Exact session API shape can be minimal and local-file backed.

## Likely codebase touchpoints
- `src/lib/protocol/types.ts`: add client session/session index types and maybe `stale` status.
- `src/lib/store/file-store.ts`: add session path/read/write/update helpers; stale run helper.
- `src/app/api/runs/route.ts`: accept `clientSessionId`, update session index after run creation.
- New `src/app/api/sessions/[clientSessionId]/route.ts` and possibly active-run route.
- `src/components/RunCreateForm.tsx`: generate/use client session id, pass to run creation, show resume UI or accept props/data.
- `src/app/page.tsx`: likely client wrapper or server-safe landing props.
- `src/components/ChatRoom.tsx`: localStorage UI state per run.
- Tests under `tests/*.test.ts`: session store/API-ish tests where practical.
- README/docs update.
