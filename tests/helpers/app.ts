import { expect, type Page } from '@playwright/test';

export async function dismissTrialEndedModal(page: Page): Promise<void> {
  const modal = page.locator('#trial-ended-modal');
  if (await modal.isVisible().catch(() => false)) {
    await page.locator('#btn-close-trial-ended').click({ timeout: 3000 }).catch(() => {});
  }
}

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#gate-email')).toBeVisible();
  await page.locator('#gate-tab-login').click();
  await page.locator('#gate-email').fill(email);
  await page.locator('#gate-password').fill(password);
  await page.locator('#btn-gate-login').click();
  await expect(page.locator('#main-app')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#auth-container')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#user-area-logged')).toBeVisible();
  await dismissTrialEndedModal(page);
}

export async function readPoints(page: Page): Promise<number> {
  const raw = (await page.locator('#user-points-label').innerText()).replace(/[^\d-]/g, '');
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Cannot parse points from "${raw}"`);
  return n;
}

export async function waitForPoints(page: Page, expected: number, timeoutMs = 45_000): Promise<void> {
  await expect
    .poll(async () => readPoints(page), { timeout: timeoutMs })
    .toBe(expected);
}

export async function readMicroRequestId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('micro_course_generation_request_')) keys.push(k);
    }
    if (!keys.length) return '';
    return String(localStorage.getItem(keys[0]) || '').trim();
  });
}

export async function importLocalCourse(
  page: Page,
  audioPath: string,
  subtitlePath: string,
  title = 'Playwright smoke course',
): Promise<void> {
  await dismissTrialEndedModal(page);
  await page.locator('#btn-import').click();
  await expect(page.locator('#import-modal')).toBeVisible();
  await page.locator('#import-tab-local').click();
  await page.locator('#import-title').fill(title);
  await page.locator('#import-audio').setInputFiles(audioPath);
  await page.locator('#import-subtitle').setInputFiles(subtitlePath);
  await page.locator('#btn-confirm-import').click();
  await expect(page.locator('#import-modal')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#course-title')).not.toHaveText('尚未选择课程');
}

export async function openGenerateModal(page: Page): Promise<void> {
  await dismissTrialEndedModal(page);
  await page.locator('#btn-v2-micro-create').click();
  await expect(page.locator('#v2-micro-test-modal')).toBeVisible();
}

export async function closeGenerateModal(page: Page): Promise<void> {
  const modal = page.locator('#v2-micro-test-modal');
  if (await modal.isVisible().catch(() => false)) {
    await page.locator('#btn-close-v2-micro-test-2').click().catch(async () => {
      await page.locator('#btn-close-v2-micro-test').click();
    });
  }
}

type RpcSpy = { url: string; postData: string };

export function attachRpcSpy(page: Page, name: string): RpcSpy[] {
  const hits: RpcSpy[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (req.method() === 'POST' && url.includes(`/rpc/${name}`)) {
      hits.push({ url, postData: req.postData() || '' });
    }
  });
  return hits;
}

export async function callMicroDeductRpc(
  page: Page,
  requestId: string,
  pCost: number,
): Promise<{ points: number | null; deducted: boolean | null; error: string }> {
  return page.evaluate(async ({ requestId: rid, pCost: cost }) => {
    const src = [...document.querySelectorAll('script')].map((s) => s.textContent || '').join('\n');
    const url = (src.match(/const SUPABASE_URL = '([^']+)'/) || [])[1];
    const key = (src.match(/const SUPABASE_ANON_KEY = '([^']+)'/) || [])[1];
    const sb = (window as unknown as {
      supabase: { createClient: (u: string, k: string) => {
        rpc: (name: string, args: Record<string, unknown>) => Promise<{
          data: unknown;
          error: { message?: string } | null;
        }>;
      } };
    }).supabase;
    if (!url || !key || !sb) return { points: null, deducted: null, error: 'supabase client missing' };
    const client = sb.createClient(url, key);
    const { data, error } = await client.rpc('deduct_points_for_micro_course', {
      p_cost: cost,
      p_request_id: rid,
    });
    const row = Array.isArray(data) ? data[0] : data;
    return {
      points: row && typeof row.points === 'number' ? row.points : null,
      deducted: row ? row.deducted === true : null,
      error: error ? String(error.message || error) : '',
    };
  }, { requestId, pCost });
}

export async function callMicroRefundRpc(page: Page, requestId: string): Promise<string> {
  return page.evaluate(async (rid) => {
    const src = [...document.querySelectorAll('script')].map((s) => s.textContent || '').join('\n');
    const url = (src.match(/const SUPABASE_URL = '([^']+)'/) || [])[1];
    const key = (src.match(/const SUPABASE_ANON_KEY = '([^']+)'/) || [])[1];
    const sb = (window as unknown as {
      supabase: { createClient: (u: string, k: string) => {
        rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>;
      } };
    }).supabase;
    const client = sb.createClient(url, key);
    const { error } = await client.rpc('refund_points_for_micro_course', { p_request_id: rid });
    return error ? String(error.message || error) : '';
  }, requestId);
}
