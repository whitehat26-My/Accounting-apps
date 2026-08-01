import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ROLE_RANK,
  can,
  canAll,
  canAny,
  canGrantRole,
  requiresFinancialEvent,
  resolvePrincipal,
  type Permission,
  type Principal,
  type RoleCode,
} from '../src/rbac.js';

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: 'u-1',
  tenantId: 't-1',
  role: 'BOOKKEEPER',
  permissions: new Set<Permission>(['invoice.create', 'invoice.read', 'bank.reconcile']),
  ...over,
});

const ROLES = Object.keys(ROLE_RANK) as RoleCode[];

describe('can', () => {
  it('allows a permission the role holds and refuses one it does not', () => {
    expect(can(principal(), 'invoice.create')).toBe(true);
    expect(can(principal(), 'period.override')).toBe(false);
  });

  it('intersects an API key with its scopes rather than unioning', () => {
    // A key issued for "read invoices" must NOT gain the ability to post
    // journals because the Owner who created it can. The narrowest wins.
    const owner = principal({
      role: 'OWNER',
      permissions: new Set<Permission>(['invoice.read', 'journal.post']),
      apiKeyId: 'key-1',
      scopes: new Set<Permission>(['invoice.read']),
    });

    expect(can(owner, 'invoice.read')).toBe(true);
    expect(can(owner, 'journal.post')).toBe(false);
  });

  it('a scope cannot grant a permission the role lacks', () => {
    const scoped = principal({
      permissions: new Set<Permission>(['invoice.read']),
      apiKeyId: 'key-1',
      scopes: new Set<Permission>(['journal.post']),
    });
    expect(can(scoped, 'journal.post')).toBe(false);
  });

  it('an API key is never wider than the role, whatever the scopes (property)', () => {
    const ALL: Permission[] = ['invoice.read', 'invoice.create', 'journal.post', 'period.override'];

    fc.assert(
      fc.property(
        fc.subarray(ALL),
        fc.subarray(ALL),
        fc.constantFrom(...ALL),
        (rolePerms, scopes, probe) => {
          const withKey = principal({
            permissions: new Set(rolePerms),
            apiKeyId: 'k',
            scopes: new Set(scopes),
          });
          const withoutKey = principal({ permissions: new Set(rolePerms) });

          if (can(withKey, probe)) expect(can(withoutKey, probe)).toBe(true);
        },
      ),
    );
  });

  it('canAll and canAny behave', () => {
    expect(canAll(principal(), ['invoice.read', 'invoice.create'])).toBe(true);
    expect(canAll(principal(), ['invoice.read', 'period.override'])).toBe(false);
    expect(canAny(principal(), ['period.override', 'invoice.read'])).toBe(true);
    expect(canAny(principal(), ['period.override', 'org.delete'])).toBe(false);
  });
});

describe('canGrantRole — privilege escalation', () => {
  it('refuses to grant a role above the actor’s own', () => {
    // Without this an Admin makes themselves Owner, and the only trace is a
    // role change that looks like every other role change.
    expect(canGrantRole('ADMIN', 'OWNER')).toBe(false);
    expect(canGrantRole('BOOKKEEPER', 'ACCOUNTANT')).toBe(false);
  });

  it('allows granting the actor’s own rank', () => {
    // An Owner must be able to appoint a second Owner, or no organisation can
    // ever change hands.
    expect(canGrantRole('OWNER', 'OWNER')).toBe(true);
  });

  it('allows granting anything below', () => {
    expect(canGrantRole('OWNER', 'READ_ONLY')).toBe(true);
    expect(canGrantRole('ADMIN', 'BOOKKEEPER')).toBe(true);
  });

  it('is transitive and never lets a chain escalate (property)', () => {
    // The property that actually matters: no sequence of legal grants can
    // produce a role stronger than the one that started the chain.
    fc.assert(
      fc.property(
        fc.constantFrom(...ROLES),
        fc.constantFrom(...ROLES),
        fc.constantFrom(...ROLES),
        (a, b, c) => {
          if (canGrantRole(a, b) && canGrantRole(b, c)) {
            expect(canGrantRole(a, c)).toBe(true);
            expect(ROLE_RANK[c]).toBeGreaterThanOrEqual(ROLE_RANK[a]);
          }
        },
      ),
    );
  });

  it('every role has a distinct rank', () => {
    expect(new Set(Object.values(ROLE_RANK)).size).toBe(ROLES.length);
  });
});

describe('resolvePrincipal', () => {
  const NOW = '2026-08-20T00:00:00.000Z';

  it('resolves an active membership', () => {
    const result = resolvePrincipal(
      'u-1',
      't-1',
      { role: 'ACCOUNTANT', status: 'ACTIVE', expiresAt: null },
      ['journal.post'],
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.role).toBe('ACCOUNTANT');
      expect(can(result.principal, 'journal.post')).toBe(true);
    }
  });

  it('reports NOT_A_MEMBER when there is no membership — the caller must 404', () => {
    // CLAUDE.md rule 9. A 403 here confirms the organisation EXISTS, which is
    // enough to enumerate the customer list of a multi-tenant accounting
    // product one id at a time.
    const result = resolvePrincipal('u-1', 't-other', undefined, [], NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial).toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('reports NOT_A_MEMBER for a suspended membership too', () => {
    const result = resolvePrincipal(
      'u-1',
      't-1',
      { role: 'ADMIN', status: 'SUSPENDED', expiresAt: null },
      ['org.manage'],
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.code).toBe('NOT_A_MEMBER');
  });

  it('expires a time-boxed external auditor', () => {
    const result = resolvePrincipal(
      'u-1',
      't-1',
      { role: 'EXTERNAL_AUDITOR', status: 'ACTIVE', expiresAt: '2026-08-19T00:00:00.000Z' },
      ['report.read'],
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.code).toBe('MEMBERSHIP_EXPIRED');
  });

  it('admits an auditor whose window is still open', () => {
    const result = resolvePrincipal(
      'u-1',
      't-1',
      { role: 'EXTERNAL_AUDITOR', status: 'ACTIVE', expiresAt: '2026-09-30T00:00:00.000Z' },
      ['report.read'],
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('carries an API key’s scopes onto the principal', () => {
    const result = resolvePrincipal(
      'u-1',
      't-1',
      { role: 'OWNER', status: 'ACTIVE', expiresAt: null },
      ['invoice.read', 'journal.post'],
      NOW,
      { id: 'key-1', scopes: ['invoice.read'] },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(can(result.principal, 'invoice.read')).toBe(true);
      expect(can(result.principal, 'journal.post')).toBe(false);
    }
  });
});

describe('financial event logging', () => {
  it('marks a locked-period override, which invariant #9 requires', () => {
    expect(requiresFinancialEvent('period.override')).toBe('LOCKED_PERIOD_OVERRIDE');
  });

  it('leaves ordinary actions to the audit log alone', () => {
    // Every mutation is audited. This list is the small set an auditor asks
    // about by name — mixing them makes the significant events invisible among
    // the routine ones.
    expect(requiresFinancialEvent('invoice.create')).toBeUndefined();
    expect(requiresFinancialEvent('bank.reconcile')).toBeUndefined();
  });
});
