import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? '3210');
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const e2eMode = process.env.AGENTBOARD_E2E_MODE ?? 'mock';
const isRealAdapterMode = e2eMode === 'cli' || e2eMode === 'tmux';
const tmuxAdapterEnv: Record<string, string> = e2eMode === 'tmux'
  ? {
    AGENTBOARD_ORCHESTRATOR_ADAPTER: process.env.AGENTBOARD_ORCHESTRATOR_ADAPTER ?? 'tmux-codex',
    AGENTBOARD_PLANNER_ADAPTER: process.env.AGENTBOARD_PLANNER_ADAPTER ?? 'tmux-codex',
    AGENTBOARD_ENGINEER_ADAPTER: process.env.AGENTBOARD_ENGINEER_ADAPTER ?? 'tmux-codex',
    AGENTBOARD_REVIEWER_ADAPTER: process.env.AGENTBOARD_REVIEWER_ADAPTER ?? 'tmux-codex',
  }
  : {};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: isRealAdapterMode ? 1 : undefined,
  timeout: isRealAdapterMode ? 180_000 : 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      AGENTBOARD_MODE: isRealAdapterMode ? 'cli' : 'mock',
      AGENTBOARD_STATE_DIR: `.agentboard/playwright-${e2eMode}-runs`,
      AGENTBOARD_MOCK_DELAY_SCALE: process.env.AGENTBOARD_MOCK_DELAY_SCALE ?? '0.2',
      AGENTBOARD_CONTINUATION_ENABLED: 'false',
      NEXT_TELEMETRY_DISABLED: '1',
      ...tmuxAdapterEnv,
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
