import { readEvents } from '@/lib/store/file-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const encoder = new TextEncoder();
  let cursor = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      async function push() {
        try {
          const events = await readEvents(runId);
          for (const event of events.slice(cursor)) {
            controller.enqueue(encoder.encode(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`));
          }
          cursor = events.length;
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch (error) {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ id: 'error', runId, type: 'error', actor: 'sse', payload: { message: (error as Error).message }, createdAt: new Date().toISOString() })}\n\n`));
        }
      }
      await push();
      const interval = setInterval(() => void push(), 750);
      setTimeout(() => {
        clearInterval(interval);
        controller.close();
      }, 60_000).unref?.();
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
