import { describe, expect, it } from 'vitest';

import { hasPermission, isRole, isStaffRole, permissionsFor, ROLES } from './roles.js';

describe('roles and permissions', () => {
  it('gives a parent the permissions to manage their own family', () => {
    for (const permission of [
      'account:read_own',
      'account:update_own',
      'account:delete_own',
      'children:manage_own',
      'conversations:read_own',
      'billing:manage_own',
    ] as const) {
      expect(hasPermission('parent', permission), permission).toBe(true);
    }
  });

  /**
   * Nobody but the account holder touches billing.
   *
   * A support agent who can cancel or resume a family's plan is a social
   * engineering target — "I'm from support, I just need to fix your
   * subscription" — and an admin who can do it silently is worse. There is no
   * permission that expresses it, so there is no path to add the button later
   * without this test failing.
   */
  it('gives no staff role any power over a family’s subscription', () => {
    expect(hasPermission('support', 'billing:manage_own')).toBe(false);
    expect(hasPermission('admin', 'billing:manage_own')).toBe(false);
  });

  it('gives a parent no staff permission', () => {
    for (const permission of [
      'accounts:read_any',
      'accounts:suspend',
      'flags:review',
      'audit:read',
      'catalogue:manage',
      'roles:assign',
    ] as const) {
      expect(hasPermission('parent', permission), permission).toBe(false);
    }
  });

  it("does not let any role read another family's children", () => {
    // There is deliberately no permission that expresses it. Staff see accounts
    // and safety metadata; access to a child's data is ownership-scoped only.
    for (const role of ROLES) {
      expect(hasPermission(role, 'children:manage_own')).toBe(role === 'parent');
    }
  });

  it('gives support review access without any power to change the product', () => {
    expect(hasPermission('support', 'flags:review')).toBe(true);
    expect(hasPermission('support', 'accounts:read_any')).toBe(true);
    expect(hasPermission('support', 'catalogue:manage')).toBe(false);
    expect(hasPermission('support', 'roles:assign')).toBe(false);
    expect(hasPermission('support', 'accounts:suspend')).toBe(false);
    expect(hasPermission('support', 'audit:read')).toBe(false);
  });

  it('makes admin a superset of support', () => {
    for (const permission of permissionsFor('support')) {
      expect(hasPermission('admin', permission), permission).toBe(true);
    }
  });

  it('never grants a staff role the ability to delete an account', () => {
    // Deletion is the account holder's right, not an operator's tool.
    expect(hasPermission('admin', 'account:delete_own')).toBe(false);
    expect(hasPermission('support', 'account:delete_own')).toBe(false);
  });

  it('identifies staff roles', () => {
    expect(isStaffRole('admin')).toBe(true);
    expect(isStaffRole('support')).toBe(true);
    expect(isStaffRole('parent')).toBe(false);
  });

  it('rejects an unknown role string', () => {
    expect(isRole('parent')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole('')).toBe(false);
  });

  it('returns a frozen permission list that a caller cannot mutate', () => {
    const permissions = permissionsFor('parent');
    expect(() => {
      (permissions as string[]).push('audit:read');
    }).toThrow();
  });
});
