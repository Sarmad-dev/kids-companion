import path from 'node:path';

import type { NextConfig } from 'next';

/**
 * This surface handles billing and personal data, so the security headers are
 * part of the app config rather than left to a reverse proxy that may or may not
 * be in front of it in every environment.
 *
 * See SECURITY.md §7.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Emits `.next/standalone` — a self-contained server with only the modules
   * actually traced as reachable.
   *
   * Without it the runtime image needs the whole `node_modules` tree, which for
   * a monorepo that also contains React Native means shipping hundreds of
   * megabytes the dashboard never loads. `outputFileTracingRoot` points at the
   * repository root so tracing follows the workspace symlinks into
   * `@kids/ui` and friends rather than stopping at this directory.
   */
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  // Fail the build on a type error rather than shipping it. Next's defaults
  // already do this; stated explicitly so nobody "temporarily" flips it.
  // (Linting is not configured here — it runs once, at the workspace root.)
  typescript: { ignoreBuildErrors: false },
  transpilePackages: ['@kids/ui', '@kids/types', '@kids/validation'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
