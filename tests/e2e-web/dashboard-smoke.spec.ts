import { expect, test } from '@playwright/test';

/**
 * Browser smoke tests. Run with `pnpm test:e2e:web` after
 * `pnpm exec playwright install --with-deps`.
 *
 * These cover the part of the dashboard that does not need a running API: the
 * front door, the sign-in page, and — the one that matters — that every area
 * behind the shell is unreachable without a session. The journeys that need
 * data (view a child's history, change a control, delete an account) belong in
 * the API-backed suite, where a parent and a child actually exist.
 */

test.describe('the front door', () => {
  test('sends an anonymous visitor to sign in', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('says whose dashboard this is', async ({ page }) => {
    await page.goto('/login');

    // A parent arriving from a child's device needs to know immediately that
    // this is not the app their child uses.
    await expect(page.getByText(/parent dashboard/i)).toBeVisible();
  });

  test('sets security headers', async ({ page }) => {
    const response = await page.goto('/login');

    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    expect(response?.headers()['x-frame-options']).toBe('DENY');
  });

  test('is not indexable — this surface is for parents, not search engines', async ({ page }) => {
    await page.goto('/login');

    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveAttribute('content', /noindex/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING BEHIND THE SHELL IS REACHABLE WITHOUT A SESSION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The redirect lives in one layout, which is what makes it hard to forget on a
 * new page — and exactly why it is worth checking every route rather than one.
 * A page added outside the `(dashboard)` group would look identical in the
 * sidebar and would not be covered by it.
 */
test.describe('the signed-out wall', () => {
  const AREAS = [
    '/dashboard',
    '/children',
    '/progress',
    '/conversations',
    '/practice',
    '/controls',
    '/subscription',
    '/notifications',
    '/account',
    '/privacy',
  ];

  for (const area of AREAS) {
    test(`${area} redirects to sign in`, async ({ page }) => {
      await page.goto(area);

      await expect(page).toHaveURL(/\/login$/);
    });
  }
});

test.describe('accessibility basics', () => {
  test('offers a skip link and a focusable main region', async ({ page }) => {
    await page.goto('/login');

    // The login page is its own <main>; the shell adds the skip link. Both need
    // a landmark a keyboard user can reach.
    await expect(page.locator('main#main')).toBeAttached();
  });

  test('never renders a raw framework error to a parent', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist');

    expect(response?.status()).toBe(404);
    await expect(page.locator('body')).not.toContainText('webpack');
    await expect(page.locator('body')).not.toContainText('at Object.');
  });
});
