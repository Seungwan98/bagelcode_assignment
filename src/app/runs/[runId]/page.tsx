import { ChatRoom } from '@/components/ChatRoom';
import { readState } from '@/lib/store/file-store';

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const state = await readState(runId);
  return <ChatRoom initialState={state} runId={runId} />;
}
