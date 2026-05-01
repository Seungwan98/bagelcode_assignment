import { expect, test, type Page } from '@playwright/test';

async function assertNoUnexpectedBrowserErrors(page: Page, browserErrors: string[]) {
  await expect.poll(() => browserErrors, { timeout: 250 }).toEqual([]);
}

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

test('새 대화에서 에이전트 협업 흐름과 로그 상세를 확인할 수 있다', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '무엇을 도와드릴까요?' })).toBeVisible();
  await expect(page.getByLabel('실행 모드 선택')).toContainText('Mock');

  await page.getByPlaceholder(/Agent들에게 요청하세요/).fill('AgentBoard UI 개선 계획과 구현 방향을 정리하고 검토해줘.');
  await page.locator('.empty-chat-actions').getByRole('button', { name: '전송' }).click();

  await expect(page.locator('.chat-topbar')).toContainText('AgentBoard Chat');
  await expect(page.locator('.chat-topbar')).toContainText('AgentBoard UI 개선 계획');
  await expect(page.locator('.agent-panel')).toHaveCount(4);

  await expect(page.locator('.agent-panel.orchestrator')).toContainText('Orchestrator Agent');
  await expect(page.locator('.agent-panel.planner')).toContainText('Planner Agent');
  await expect(page.locator('.agent-panel.engineer')).toContainText('Engineer Agent');
  await expect(page.locator('.agent-panel.reviewer')).toContainText('Reviewer Agent');

  await expect(page.getByRole('button', { name: '취소' })).toBeVisible();
  await expect(page.getByLabel('Agents에게 보낼 메시지')).toBeDisabled();

  await expect(page.locator('.chat-topbar .badge').filter({ hasText: /^completed$/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Agents에게 보낼 메시지')).toBeEnabled();
  await expect(page.locator('.agent-panel.planner .assignment-card')).toContainText('Orchestrator assigned');
  await expect(page.locator('.agent-panel.reviewer')).toContainText('사용자에게 전달할 최종 답변');

  await page.getByRole('button', { name: /Logs \d+/ }).click();
  await expect(page.getByRole('heading', { name: 'Agent handoff logs' })).toBeVisible();
  await expect(page.locator('.process-log-trigger').first()).toBeVisible();
  await expect(page.locator('.process-log-trigger').filter({ hasText: 'Orchestrator 검증: 완료' }).first()).toBeVisible();

  await page.locator('.process-log-trigger').filter({ hasText: 'Orchestrator Agent → Planner Agent' }).first().click();
  await expect(page.getByRole('dialog', { name: /Orchestrator Agent → Planner Agent/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Raw payload');
  await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('완료된 대화는 세션 목록에서 다시 열고 삭제할 수 있다', async ({ page }) => {
  await page.goto('/');

  await page.getByPlaceholder(/Agent들에게 요청하세요/).fill('삭제 QA를 위한 간단한 질문에 답해줘.');
  await page.locator('.empty-chat-actions').getByRole('button', { name: '전송' }).click();
  await expect(page.locator('.chat-topbar .badge').filter({ hasText: /^completed$/ })).toBeVisible({ timeout: 15_000 });

  const sessionItem = page.locator('.session-list-item').filter({ hasText: '삭제 QA를 위한 간단한 질문' }).first();
  await expect(sessionItem).toBeVisible();
  await sessionItem.locator('.session-select-button').click();
  await expect(page.locator('.chat-topbar')).toContainText('삭제 QA를 위한 간단한 질문');

  page.once('dialog', (dialog) => dialog.accept());
  await sessionItem.getByRole('button', { name: /삭제 QA를 위한 간단한 질문.*삭제/ }).click();
  await expect(page.getByRole('heading', { name: '무엇을 도와드릴까요?' })).toBeVisible();
  await expect(page.locator('.session-list-item').filter({ hasText: '삭제 QA를 위한 간단한 질문' })).toHaveCount(0);
});
