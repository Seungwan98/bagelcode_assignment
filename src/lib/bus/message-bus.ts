import type { AgentMessage, MessageKind } from '@/lib/protocol/types';
import { appendEvent, appendMessage } from '@/lib/store/file-store';
import { createId, nowIso } from '@/lib/utils/ids';

export interface SendMessageInput {
  runId: string;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  correlationId?: string;
  requiresAck?: boolean;
}

export async function sendMessage(input: SendMessageInput): Promise<AgentMessage> {
  const createdAt = nowIso();
  const message: AgentMessage = {
    id: createId('msg'),
    runId: input.runId,
    from: input.from,
    to: input.to,
    kind: input.kind,
    body: input.body,
    correlationId: input.correlationId,
    requiresAck: input.requiresAck,
    createdAt,
    deliveredAt: createdAt,
  };
  await appendMessage(message);
  await appendEvent(input.runId, {
    id: createId('evt'),
    runId: input.runId,
    type: input.kind === 'user_intervention' ? 'user.intervened' : 'message.sent',
    actor: input.from,
    payload: { message },
    createdAt,
  });
  await appendEvent(input.runId, {
    id: createId('evt'),
    runId: input.runId,
    type: 'message.delivered',
    actor: 'message-bus',
    payload: { messageId: message.id, to: message.to },
    createdAt: nowIso(),
  });
  return message;
}
