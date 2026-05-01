import { ChatWorkspace } from '@/components/ChatWorkspace';

export default function HomePage() {
  const initialMode = process.env.AGENTBOARD_MODE === 'cli' ? 'cli' : 'mock';

  return <ChatWorkspace initialMode={initialMode} />;
}
