/**
 * Roles and permissions.
 *
 * Permissions live in code rather than in a table, deliberately. A permission
 * grant is a security decision: it belongs in version control, in a diff a
 * reviewer reads, not in a row an operator can change at 2 a.m. with no record.
 * The database holds only the role; what a role may DO is defined here.
 */

export const ROLES = ['parent', 'admin', 'support'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  /* Parent-facing: always scoped to resources the caller owns. */
  'account:read_own',
  'account:update_own',
  'account:delete_own',
  'children:manage_own',
  'conversations:read_own',
  'sessions:read_own',
  'sessions:revoke_own',
  'billing:manage_own',

  /* Staff. */
  'accounts:read_any',
  'accounts:suspend',
  'flags:review',
  'audit:read',
  'catalogue:manage',
  'roles:assign',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * What each role may do.
 *
 * Note what is absent everywhere: no permission grants access to a child's
 * conversation content. Staff can see accounts and safety metadata, never what a
 * child said. An operator browsing transcripts out of curiosity is a threat this
 * product designs against (SECURITY.md §1.2), so there is no permission to
 * express it — the review queue is a separate, audited path.
 */
/*
 * Both levels are frozen. Freezing only the outer record leaves the arrays
 * mutable, so any code holding a reference could push a permission onto the
 * shared list at runtime — a privilege escalation with no diff to review.
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  parent: Object.freeze([
    'account:read_own',
    'account:update_own',
    'account:delete_own',
    'children:manage_own',
    'conversations:read_own',
    'sessions:read_own',
    'sessions:revoke_own',
    'billing:manage_own',
  ] as const),

  // Support triages the safety queue and answers account questions. It is the
  // broader of the two staff roles in reach and the narrower in power: it can
  // read and act on flags, and cannot change anything about the product.
  support: Object.freeze([
    'account:read_own',
    'account:update_own',
    'sessions:read_own',
    'sessions:revoke_own',
    'accounts:read_any',
    'flags:review',
  ] as const),

  admin: Object.freeze([
    'account:read_own',
    'account:update_own',
    'sessions:read_own',
    'sessions:revoke_own',
    'accounts:read_any',
    'accounts:suspend',
    'flags:review',
    'audit:read',
    'catalogue:manage',
    'roles:assign',
  ] as const),
});

export const permissionsFor = (role: Role): readonly Permission[] => ROLE_PERMISSIONS[role];

export const hasPermission = (role: Role, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

/**
 * Staff roles. Kept as a predicate rather than scattered `=== 'admin'` checks,
 * so adding a role means editing one place instead of grepping for comparisons.
 */
export const isStaffRole = (role: Role): boolean => role === 'admin' || role === 'support';
