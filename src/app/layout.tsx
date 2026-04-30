import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentBoard',
  description: 'Chat-style multi-agent collaboration workspace',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
