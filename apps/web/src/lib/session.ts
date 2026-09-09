import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Parent authentication.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TOKEN NEVER REACHES THE BROWSER'S JAVASCRIPT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It lives in an httpOnly, SameSite=Strict, Secure cookie. Every API call is
 * made from a Server Component or a Server Action, so the token is attached on
 * the server and no client bundle ever holds it. An XSS in this app cannot read
 * it, because there is nothing in `document` to read.
 *
 * AND THE COOKIE IS NOT THE AUTHORISATION. It only says who is asking. Every
 * endpoint behind it re-checks ownership, and RLS re-checks it again in the
 * database — `requireParent` below decides whether to render a page, never
 * whether a parent may see a particular child. A frontend check is a convenience
 * for the person using it, not a control.
 */

const SESSION_COOKIE = 'kc_session';

export interface ParentSession {
  readonly accessToken: string;
}

/** The cookie options. Every one of them is doing something. */
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  // Cookies are only sent over TLS outside local development. A session cookie
  // on a plaintext connection is a session cookie on someone else's wifi.
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 12,
};

export const readSession = async (): Promise<ParentSession | undefined> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token === undefined || token === '' ? undefined : { accessToken: token };
};

/**
 * Requires a signed-in parent, or sends them to sign in.
 *
 * Called at the top of the dashboard layout so it runs once for every page
 * beneath it rather than being remembered thirteen times.
 */
export const requireParent = async (): Promise<ParentSession> => {
  const session = await readSession();
  if (!session) redirect('/login');
  return session;
};

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
