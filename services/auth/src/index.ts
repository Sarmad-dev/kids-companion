/**
 * @kids/auth — parent authentication and authorization.
 *
 * Children do not authenticate. Nothing here mints a credential for a child;
 * a child is data owned by a parent (docs/adr/0005).
 */

export { ROLES, PERMISSIONS, permissionsFor, hasPermission, isRole, isStaffRole } from './roles.js';
export type { Role, Permission } from './roles.js';

export { DuplicateEmailError } from './ports.js';
export type {
  AuthIdentity,
  AuthProvider,
  CredentialCheck,
  RegisterInput,
  RegisterResult,
} from './ports.js';

export {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  safeEquals,
  DEFAULT_HASH_PARAMS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from './passwords.js';
export type { PasswordHashParams, PasswordPolicyResult } from './passwords.js';

export { createTokenService, hashToken } from './tokens.js';
export type { AccessTokenClaims, TokenService, TokenServiceOptions } from './tokens.js';

export { createSessionService } from './sessions.js';
export type {
  IssuedSession,
  RefreshOutcome,
  SessionContext,
  SessionRecord,
  SessionService,
} from './sessions.js';

export { createLocalAuthAdapter } from './local-adapter.js';
export type { LocalAuthAdapterOptions } from './local-adapter.js';

export { createSupabaseAuthAdapter } from './supabase-adapter.js';
export type { SupabaseAuthAdapterOptions } from './supabase-adapter.js';
