import { expect, test, type Page } from '@playwright/test';

const adapterMode = process.env.AGENTBOARD_E2E_MODE;
const realAdapterMode = adapterMode === 'cli' || adapterMode === 'tmux';
const hasCodexCommand = Boolean(process.env.AGENTBOARD_CODEX_CMD?.trim());

async function assertNoUnexpectedBrowserErrors(page: Page, browserErrors: string[]) {
  await expect.poll(() => browserErrors, { timeout: 250 }).toEqual([]);
}

test.describe('real adapter QA', () => {
  test.skip(!realAdapterMode, 'real adapter QA only runs with AGENTBOARD_E2E_MODE=cli or tmux');
  test.skip(!hasCodexCommand, 'AGENTBOARD_CODEX_CMD is required for real adapter QA');

  test.beforeEach(async ({ page }) => {
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/^Failed to load resource:/.test(text)) return;
      browserErrors.push(text);
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      if (url.pathname === '/favicon.ico') return;
      browserErrors.push(`${response.status()} ${url.pathname}`);
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    (page as Page & { __agentboardBrowserErrors?: string[] }).__agentboardBrowserErrors = browserErrors;
  });

  test.afterEach(async ({ page }) => {
    const errors = (page as Page & { __agentboardBrowserErrors?: string[] }).__agentboardBrowserErrors ?? [];
    await assertNoUnexpectedBrowserErrors(page, errors);
  });

  test('실제 CLI 계열 adapter에서 Orchestrator 검증 후 사용자 응답을 표시한다', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.workspace-mode-switch label.selected')).toContainText('CLI');
    await page.getByPlaceholder(/Agent들에게 요청하세요/).fill('실제 adapter QA입니다. 한 문단으로 답하고 검증 로그를 남겨줘.');
    await page.locator('.empty-chat-actions').getByRole('button', { name: '전송' }).click();

    await expect(page.locator('.chat-topbar .badge').filter({ hasText: /^completed$/ })).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('.agent-panel.orchestrator')).toContainText('Orchestrator Agent');
    await expect(page.locator('.agent-panel.reviewer')).toContainText('Reviewer Agent');

    if (adapterMode === 'tmux') {
      await expect(page.locator('.agent-panel.orchestrator')).toContainText('Session:');
      await expect(page.locator('.agent-panel.orchestrator')).toContainText(/tmux/);
    }

    await page.getByRole('button', { name: /Logs \d+/ }).click();
    await expect(page.locator('.process-log-trigger').filter({ hasText: /Orchestrator 검증/ }).first()).toBeVisible();
    await expect(page.locator('.process-log-trigger').filter({ hasText: /adapter output|session output_captured/ }).first()).toBeVisible();
  });
});
