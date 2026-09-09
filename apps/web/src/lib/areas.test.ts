import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const DASHBOARD = join(SRC, 'app', '(dashboard)');

/**
 * Every area in the sidebar is a real page, with all four states.
 *
 * A link in the navigation that 404s is the kind of thing that survives review —
 * the sidebar renders, the page it points at was going to be written later, and
 * nobody clicks every item. The parent who clicks it is the one who wanted that
 * page.
 *
 * `loading.tsx` and `error.tsx` are checked here for the same reason: Next.js
 * treats both as optional, so their absence is silent, and what a parent gets
 * instead is a blank screen while data loads and a raw framework error page when
 * it fails.
 */
const areas = (): readonly string[] => {
  const nav = readFileSync(join(SRC, 'components', 'nav.tsx'), 'utf8');
  return [...nav.matchAll(/\['\/([a-z]+)', '/g)].map((match) => match[1] ?? '');
};

describe('the dashboard areas', () => {
  it('finds the sidebar', () => {
    expect(areas().length).toBe(10);
  });

  it('has a page for every link in the sidebar', () => {
    for (const area of areas()) {
      expect(existsSync(join(DASHBOARD, area, 'page.tsx')), `${area} has no page`).toBe(true);
    }
  });

  it('has a loading state for every area', () => {
    for (const area of areas()) {
      expect(existsSync(join(DASHBOARD, area, 'loading.tsx')), `${area} has no loading`).toBe(true);
    }
  });

  it('has an error boundary for every area', () => {
    for (const area of areas()) {
      expect(existsSync(join(DASHBOARD, area, 'error.tsx')), `${area} has no error`).toBe(true);
    }
  });

  /**
   * The error boundary must not render the error.
   *
   * A Next.js error object can carry a stack, an internal hostname, or a
   * fragment of a query. None of it helps a parent, and all of it is ours.
   */
  it('never renders the thrown error to the parent', () => {
    for (const area of areas()) {
      const source = readFileSync(join(DASHBOARD, area, 'error.tsx'), 'utf8');
      expect(source, `${area} renders the error`).not.toMatch(/\{error\.(message|stack|digest)\}/);
    }
  });

  /**
   * Every page must be dynamic.
   *
   * These pages read a cookie and show one family's data. A page that got
   * statically optimised — or cached at the edge — would be one family's
   * dashboard served to another, which is the worst bug this product could have.
   */
  it('renders every page dynamically', () => {
    for (const area of areas()) {
      const source = readFileSync(join(DASHBOARD, area, 'page.tsx'), 'utf8');
      expect(source, `${area} is not force-dynamic`).toContain(
        "export const dynamic = 'force-dynamic'",
      );
    }
  });
});
