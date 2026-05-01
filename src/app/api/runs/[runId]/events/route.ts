import { readEvents } from '@/lib/store/file-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const encoder = new TextEncoder();
  let cursor = 0;
  let closed = false;
  let interval: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;

  function cleanup() {
    if (interval) {
      clearInterval(interval);
    }
    if (timeout) {
      clearTimeout(timeout);
    }
    interval = undefined;
    timeout = undefined;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function safeEnqueue(payload: string) {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
          cleanup();
        }
      }

      function safeClose() {
        if (closed) {
          return;
        }

        closed = true;
        cleanup();

        try {
          controller.close();
        } catch {
          // The browser or Next.js may have already closed the stream.
        }
      }

      async function push() {
        if (closed) {
          return;
        }

        try {
          const events = await readEvents(runId);
          if (closed) {
            return;
          }

          for (const event of events.slice(cursor)) {
            safeEnqueue(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
          }
          cursor = events.length;
          safeEnqueue(`: heartbeat ${Date.now()}\n\n`);
        } catch (error) {
          safeEnqueue(`event: message\ndata: ${JSON.stringify({ id: 'error', runId, type: 'error', actor: 'sse', payload: { message: error instanceof Error ? error.message : String(error) }, createdAt: new Date().toISOString() })}\n\n`);
        }
      }
      await push();
      interval = setInterval(() => void push(), 750);
      timeout = setTimeout(() => safeClose(), 60_000);
      timeout.unref?.();
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
