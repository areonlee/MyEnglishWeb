import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { resolveAudioPath } from './helpers/audio';
import {
  attachRpcSpy,
  callMicroDeductRpc,
  callMicroRefundRpc,
  dismissTrialEndedModal,
  importLocalCourse,
  login,
  openGenerateModal,
  readMicroRequestId,
  readPoints,
  waitForPoints,
} from './helpers/app';
import { hasCredentials, liveAsrEnabled, optionalEnv, requiredEnv, resolveSubtitlePath } from './helpers/env';

/**
 * Production smoke tests for first release.
 *
 * Serial: paid flows share one account and must not overlap.
 * Screenshots / traces / retries: playwright.config.ts
 */

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(30_000);
});

test.describe('1. User authentication', () => {
  test('login with TEST_EMAIL succeeds and home loads', async ({ page }) => {
    test.skip(!hasCredentials('TEST_EMAIL', 'TEST_PASSWORD'), 'Set TEST_EMAIL and TEST_PASSWORD');
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    await expect(page.locator('#user-points-label')).toBeVisible();
    await expect(page.locator('#btn-import')).toBeVisible();
    await expect(page.locator('#btn-v2-micro-create')).toBeVisible();
  });
});

test.describe('2–5. Import, pay, refresh, refund', () => {
  test.beforeEach(({}, testInfo) => {
    if (!hasCredentials('TEST_EMAIL', 'TEST_PASSWORD')) {
      testInfo.skip(true, 'Set TEST_EMAIL and TEST_PASSWORD');
    }
  });

  test('2. local audio upload makes generate available', async ({ page }) => {
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    await importLocalCourse(page, resolveAudioPath(), resolveSubtitlePath());
    await openGenerateModal(page);
    await expect(page.locator('#btn-v2-generate-micro')).toBeEnabled();
    await expect(page.locator('#v2-micro-source')).toBeVisible();
  });

  test('3. generate deducts exactly 10 and blocks double click', async ({ page }) => {
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    await importLocalCourse(page, resolveAudioPath(), resolveSubtitlePath(), 'Playwright pay flow');

    const beforePoints = await readPoints(page);
    expect(beforePoints, 'Need at least 10 points on TEST_EMAIL').toBeGreaterThanOrEqual(10);

    const deductCalls = attachRpcSpy(page, 'deduct_points_for_micro_course');
    await openGenerateModal(page);
    const generateBtn = page.locator('#btn-v2-generate-micro');
    await expect(generateBtn).toBeEnabled();

    await generateBtn.click();
    await expect(generateBtn).toHaveText(/生成中/, { timeout: 15_000 });
    await generateBtn.click({ force: true }).catch(() => {});
    await generateBtn.click({ force: true }).catch(() => {});

    await expect(page.locator('#v2-micro-result')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('#v2-micro-result-title')).toContainText('微课生成完成');
    expect(await page.locator('#v2-micro-lesson-list li').count()).toBeGreaterThan(0);

    await waitForPoints(page, beforePoints - 10);
    expect(deductCalls.length, 'duplicate deduct RPC').toBe(1);
    expect(await readPoints(page)).toBe(beforePoints - 10);
  });

  test('4. refresh during generation does not deduct a second 10', async ({ page }) => {
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    await importLocalCourse(page, resolveAudioPath(), resolveSubtitlePath(), 'Playwright refresh recovery');

    const beforePoints = await readPoints(page);
    expect(beforePoints).toBeGreaterThanOrEqual(10);

    const deductCalls = attachRpcSpy(page, 'deduct_points_for_micro_course');
    await openGenerateModal(page);

    const deductSeen = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes('/rpc/deduct_points_for_micro_course'),
      { timeout: 30_000 },
    );
    await page.locator('#btn-v2-generate-micro').click();
    await deductSeen;
    await page.waitForTimeout(400);

    const requestIdBeforeReload = await readMicroRequestId(page);
    expect(requestIdBeforeReload, 'request_id should persist before refresh').toBeTruthy();

    await page.reload();
    await expect(page.locator('#main-app')).toBeVisible({ timeout: 30_000 });
    await dismissTrialEndedModal(page);

    const requestIdAfterReload = await readMicroRequestId(page);
    expect(requestIdAfterReload).toBe(requestIdBeforeReload);

    await openGenerateModal(page);
    await page.locator('#btn-v2-generate-micro').click();
    await expect(page.locator('#v2-micro-result')).toBeVisible({ timeout: 120_000 });

    const afterPoints = await readPoints(page);
    expect(afterPoints, 'second deduction after refresh').toBe(beforePoints - 10);
    expect(deductCalls.length).toBeGreaterThanOrEqual(1);
    expect(deductCalls.length).toBeLessThanOrEqual(2);
  });

  test('5. failed generate refunds once (controlled 500 on generated_courses)', async ({ page }) => {
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    await importLocalCourse(page, resolveAudioPath(), resolveSubtitlePath(), 'Playwright refund flow');

    const beforePoints = await readPoints(page);
    expect(beforePoints).toBeGreaterThanOrEqual(10);

    await page.route('**/rest/v1/generated_courses*', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'playwright forced generate failure' }),
        });
        return;
      }
      await route.continue();
    });

    const refundCalls = attachRpcSpy(page, 'refund_points_for_micro_course');
    await openGenerateModal(page);
    await page.locator('#btn-v2-generate-micro').click();

    await expect(page.locator('#v2-micro-error')).toBeVisible({ timeout: 60_000 });
    await waitForPoints(page, beforePoints, 60_000);
    expect(await readPoints(page)).toBe(beforePoints);
    expect(refundCalls.length).toBe(1);

    await page.unroute('**/rest/v1/generated_courses*');
  });
});

test.describe('6. VIP permission', () => {
  test('VIP user can open generate micro course', async ({ page }) => {
    const email = optionalEnv('VIP_EMAIL') || optionalEnv('TEST_EMAIL');
    const password = optionalEnv('VIP_PASSWORD') || optionalEnv('TEST_PASSWORD');
    test.skip(!email || !password, 'Set VIP_EMAIL/VIP_PASSWORD or TEST_EMAIL/TEST_PASSWORD');
    await login(page, email, password);
    await expect(page.locator('#trial-ended-modal')).toBeHidden();
    await page.locator('#btn-v2-micro-create').click();
    await expect(page.locator('#v2-micro-test-modal')).toBeVisible();
    await expect(page.locator('#trial-ended-modal')).toBeHidden();
  });

  test('expired user is blocked with membership message', async ({ page }) => {
    test.skip(
      !hasCredentials('EXPIRED_EMAIL', 'EXPIRED_PASSWORD'),
      'Set EXPIRED_EMAIL and EXPIRED_PASSWORD',
    );
    await login(page, requiredEnv('EXPIRED_EMAIL'), requiredEnv('EXPIRED_PASSWORD'));
    await page.locator('#btn-v2-micro-create').click();
    await expect(page.locator('#trial-ended-modal')).toBeVisible();
    await expect(page.locator('#trial-ended-message')).toContainText(/试用期已届满|试用期已结束|升级/);
    await expect(page.locator('#v2-micro-test-modal')).toBeHidden();
  });
});

test.describe('7. ASR regression smoke', () => {
  test('sensevoice is the default system mode and Whisper UI is hidden', async ({ page }) => {
    test.skip(!hasCredentials('TEST_EMAIL', 'TEST_PASSWORD'), 'Set TEST_EMAIL and TEST_PASSWORD');
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    await page.locator('#btn-import').click();
    await page.locator('#import-tab-ai').click();
    await expect(page.locator('#asr-mode-system')).toBeChecked();
    await expect(page.locator('#asr-openai-whisper-ui')).toBeHidden();
    await expect(page.locator('#asr-system-points-hint')).toContainText('10');
  });

  test('no timestamp segments does not create fake subtitles', async ({ page }) => {
    test.skip(!hasCredentials('TEST_EMAIL', 'TEST_PASSWORD'), 'Set TEST_EMAIL and TEST_PASSWORD');
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));

    await page.route('**/functions/v1/transcribe-audio', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: '精准字幕服务未返回时间轴，请稍后重试',
          code: 'NO_TIMESTAMP_SEGMENTS',
          refunded: true,
        }),
      });
    });

    await page.locator('#btn-import').click();
    await page.locator('#import-tab-ai').click();
    await page.locator('#import-audio-ai').setInputFiles(resolveAudioPath());
    await page.locator('#btn-confirm-import').click();

    await expect(page.locator('#import-error')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#import-error')).toContainText(/时间轴|时间戳/);
    await expect(page.locator('#import-modal')).toBeVisible();
    await page.unroute('**/functions/v1/transcribe-audio');
  });

  test('live qwen_asr still works (optional, costs 10 points)', async ({ page }) => {
    test.skip(!liveAsrEnabled(), 'Set TEST_RUN_LIVE_ASR=1 to run live Edge ASR');
    test.skip(!hasCredentials('TEST_EMAIL', 'TEST_PASSWORD'), 'Set TEST_EMAIL and TEST_PASSWORD');
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    const before = await readPoints(page);
    expect(before).toBeGreaterThanOrEqual(10);

    await page.locator('#btn-import').click();
    await page.locator('#import-tab-ai').click();
    const liveAudio = optionalEnv('TEST_AUDIO_PATH');
    test.skip(!liveAudio, 'Live ASR needs a real TEST_AUDIO_PATH (silent wav will not transcribe well)');
    await page.locator('#import-audio-ai').setInputFiles(liveAudio);
    await page.locator('#btn-confirm-import').click();
    await expect(page.locator('#import-modal')).toBeHidden({ timeout: 180_000 });
    await expect(page.locator('#course-title')).not.toHaveText('尚未选择课程');
    const after = await readPoints(page);
    expect([before - 10, before]).toContain(after);
  });
});

test.describe('8. Security: p_cost is ignored', () => {
  test('p_cost=1 and p_cost=9999 still charge 10, then refund', async ({ page }) => {
    test.skip(!hasCredentials('TEST_EMAIL', 'TEST_PASSWORD'), 'Set TEST_EMAIL and TEST_PASSWORD');
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    const before = await readPoints(page);
    expect(before).toBeGreaterThanOrEqual(10);

    const idCheap = randomUUID();
    const cheap = await callMicroDeductRpc(page, idCheap, 1);
    expect(cheap.error, cheap.error).toBe('');
    expect(cheap.deducted).toBe(true);
    if (cheap.points != null) expect(cheap.points).toBe(before - 10);

    const refund1 = await callMicroRefundRpc(page, idCheap);
    expect(refund1).toBe('');
    await page.waitForTimeout(500);
    await waitForPoints(page, before, 30_000);

    const idExpensive = randomUUID();
    const expensive = await callMicroDeductRpc(page, idExpensive, 9999);
    expect(expensive.error, expensive.error).toBe('');
    expect(expensive.deducted).toBe(true);
    if (expensive.points != null) expect(expensive.points).toBe(before - 10);

    const refund2 = await callMicroRefundRpc(page, idExpensive);
    expect(refund2).toBe('');
    await waitForPoints(page, before, 30_000);
  });

  test('second refund on same request_id does not add extra points', async ({ page }) => {
    test.skip(!hasCredentials('TEST_EMAIL', 'TEST_PASSWORD'), 'Set TEST_EMAIL and TEST_PASSWORD');
    await login(page, requiredEnv('TEST_EMAIL'), requiredEnv('TEST_PASSWORD'));
    const before = await readPoints(page);
    expect(before).toBeGreaterThanOrEqual(10);
    const id = randomUUID();
    const deduct = await callMicroDeductRpc(page, id, 10);
    expect(deduct.error).toBe('');
    await callMicroRefundRpc(page, id);
    await waitForPoints(page, before, 30_000);
    await callMicroRefundRpc(page, id);
    await page.waitForTimeout(800);
    expect(await readPoints(page)).toBe(before);
  });
});
