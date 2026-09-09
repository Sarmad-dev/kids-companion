import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { ErrorBanner, Field } from '../../components/ui';
import { API_BASE_URL } from '../../lib/api';
import { text } from '../../lib/forms';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../../lib/session';

/**
 * Parent sign-in.
 *
 * The whole exchange happens in a Server Action: the credential is posted to
 * this server, forwarded to the API, and the returned token is written straight
 * into an httpOnly cookie. It never touches client JavaScript, so this page
 * works with JavaScript disabled and an XSS cannot read the session.
 *
 * The failure message is deliberately identical for a wrong password, an unknown
 * address, and a locked account. Distinguishing them tells someone probing which
 * half of their guess to keep.
 */

const signIn = async (formData: FormData): Promise<void> => {
  'use server';

  const email = text(formData, 'email');
  const password = text(formData, 'password');

  if (email === '' || password === '') redirect('/login?error=1');

  let token: string | undefined;
  try {
    const response = await fetch(`${API_BASE_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    });

    if (response.ok) {
      const body = (await response.json()) as { accessToken?: unknown };
      if (typeof body.accessToken === 'string') token = body.accessToken;
    }
  } catch {
    // A transport failure is reported the same way as a rejected credential.
    // The distinction is not useful to a parent and is useful to an attacker.
  }

  if (token === undefined) redirect('/login?error=1');

  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions);
  redirect('/dashboard');
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const failed = params.error !== undefined;

  return (
    <main
      className="main"
      style={{ maxWidth: 420, margin: '0 auto', paddingTop: 'var(--space-7)' }}
      id="main"
    >
      <h1 style={{ marginBottom: 'var(--space-2)' }}>Sign in</h1>
      <p className="muted small" style={{ marginBottom: 'var(--space-5)' }}>
        This is the parent dashboard. Your child signs in on their own device.
      </p>

      {failed && (
        <ErrorBanner>
          We could not sign you in. Check your email address and password and try again.
        </ErrorBanner>
      )}

      <form action={signIn} className="card">
        <Field label="Email address" htmlFor="email">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            aria-describedby={failed ? 'signin-error' : undefined}
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>

        <button className="button" type="submit" style={{ width: '100%' }}>
          Sign in
        </button>
      </form>
    </main>
  );
}
