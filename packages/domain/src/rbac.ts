/**
 * Role-based access control — M0.
 *
 * ---------------------------------------------------------------------------
 * RBAC IS A GUARD; RLS IS THE BOUNDARY. THEY ANSWER DIFFERENT QUESTIONS.
 *
 * Row-level security answers "may this connection see this tenant's rows at
 * all", and it is enforced by PostgreSQL so an application bug cannot bypass
 * it. RBAC answers "may this member perform this action within a tenant they
 * already legitimately belong to". That is a different question, it is
 * within-tenant, and pushing it into RLS policies would mean encoding the
 * permission matrix into every policy on every table and re-running a
 * migration to change a role.
 *
 * So: guard first, RLS underneath. The consequence worth being explicit about
 * is that an RBAC bug leaks data WITHIN one tenant — bad, but bounded — while
 * an RLS bug leaks across tenants. That asymmetry is why the boundary is the
 * one enforced by the database.
 * ---------------------------------------------------------------------------
 *
 * Pure. The permission set is loaded by the caller and passed in, which keeps
 * this testable exhaustively and means a permission check never touches IO on
 * a hot request path.
 */

/** The fixed role set. Mirrors `app_role` in migration 0012. */
export type RoleCode =
  | 'OWNER'
  | 'ADMIN'
  | 'ACCOUNTANT'
  | 'APPROVER'
  | 'BOOKKEEPER'
  | 'SALES'
  | 'READ_ONLY'
  | 'EXTERNAL_AUDITOR';

/**
 * Permission strings, as fine-grained as the actions they gate.
 *
 * A union rather than `string`: a typo in a guard would otherwise be a
 * permission nobody holds, which fails CLOSED and is therefore invisible in
 * testing until a user reports they cannot do their job.
 */
export type Permission =
  | 'invoice.read'
  | 'invoice.create'
  | 'creditnote.create'
  | 'receipt.create'
  | 'bill.read'
  | 'bill.create'
  | 'bill.approve'
  | 'payment.create'
  | 'debitnote.create'
  | 'journal.read'
  | 'journal.post'
  | 'period.lock'
  | 'period.override'
  | 'bank.read'
  | 'bank.import'
  | 'bank.reconcile'
  | 'report.read'
  | 'contact.read'
  | 'contact.write'
  | 'tax.read'
  | 'tax.write'
  | 'einvoice.submit'
  | 'user.read'
  | 'user.manage'
  | 'apikey.manage'
  | 'audit.read'
  | 'system.read'
  | 'item.read'
  | 'item.write'
  | 'stock.read'
  | 'stock.adjust'
  | 'pos.sale'
  | 'repair.read'
  | 'repair.write'
  | 'org.manage'
  | 'org.delete';

/**
 * Who a request is acting as, within one organisation.
 *
 * `tenantId` is here rather than alongside because a principal without a
 * tenant has no permissions at all — permissions are a property of a
 * membership, never of a user.
 */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: RoleCode;
  readonly permissions: ReadonlySet<Permission>;
  /** Present for an API key, absent for a user session. */
  readonly apiKeyId?: string;
  /** An API key's own scopes, which further narrow the role's permissions. */
  readonly scopes?: ReadonlySet<Permission>;
}

/**
 * Whether a principal may perform an action.
 *
 * An API key is intersected with its scopes, never unioned: a key issued for
 * "read invoices" must not gain the ability to post journals because the user
 * who created it is an Owner. The narrowest of the two always wins.
 */
export function can(principal: Principal, permission: Permission): boolean {
  if (!principal.permissions.has(permission)) return false;
  if (principal.scopes !== undefined && !principal.scopes.has(permission)) return false;
  return true;
}

export function canAll(
  principal: Principal,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((p) => can(principal, p));
}

export function canAny(
  principal: Principal,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((p) => can(principal, p));
}

/** Ranks from `app_role`. Lower binds tighter. */
export const ROLE_RANK: Readonly<Record<RoleCode, number>> = {
  OWNER: 0,
  ADMIN: 1,
  ACCOUNTANT: 2,
  APPROVER: 3,
  BOOKKEEPER: 4,
  SALES: 5,
  READ_ONLY: 6,
  EXTERNAL_AUDITOR: 7,
};

/**
 * Whether `actor` may grant `target`.
 *
 * Privilege escalation is the failure this prevents, and it is not theoretical:
 * without it an Admin can make themselves Owner, or grant Owner to an accomplice,
 * and the only trace is a role change that looks like every other role change.
 *
 * The rule is that you may never grant a role that outranks your own. Granting
 * your OWN rank is allowed — an Owner needs to be able to appoint a second
 * Owner, or no organisation could ever transfer hands.
 */
export function canGrantRole(actor: RoleCode, target: RoleCode): boolean {
  return ROLE_RANK[actor] <= ROLE_RANK[target];
}

export type AccessDenial =
  | { readonly code: 'NOT_A_MEMBER'; readonly tenantId: string }
  | { readonly code: 'MEMBERSHIP_EXPIRED'; readonly tenantId: string }
  | { readonly code: 'MISSING_PERMISSION'; readonly permission: Permission };

/**
 * Resolve a principal for a tenant, or say why not.
 *
 * ---------------------------------------------------------------------------
 * THE CALLER MUST TURN `NOT_A_MEMBER` INTO A 404, NOT A 403.
 *
 * CLAUDE.md rule 9. A 403 on a tenant you do not belong to confirms that the
 * tenant EXISTS, which is enough to enumerate the customer list of a
 * multi-tenant accounting product one organisation id at a time. A 404 says
 * nothing.
 *
 * `MISSING_PERMISSION` is different and IS a 403: you are legitimately inside
 * the tenant, so confirming the resource exists tells an attacker nothing they
 * could not already learn.
 * ---------------------------------------------------------------------------
 */
export function resolvePrincipal(
  userId: string,
  tenantId: string,
  membership: { role: RoleCode; status: string; expiresAt?: string | null } | undefined,
  permissions: readonly Permission[],
  now: string,
  apiKey?: { id: string; scopes: readonly Permission[] },
): { ok: true; principal: Principal } | { ok: false; denial: AccessDenial } {
  if (membership === undefined || membership.status !== 'ACTIVE') {
    return { ok: false, denial: { code: 'NOT_A_MEMBER', tenantId } };
  }

  // An external auditor's access is time-boxed. An expired membership is a
  // membership, so this is distinguishable from never having had one — but the
  // caller should still answer 404, for the same reason as above.
  if (membership.expiresAt != null && membership.expiresAt <= now) {
    return { ok: false, denial: { code: 'MEMBERSHIP_EXPIRED', tenantId } };
  }

  return {
    ok: true,
    principal: {
      userId,
      tenantId,
      role: membership.role,
      permissions: new Set(permissions),
      ...(apiKey !== undefined
        ? { apiKeyId: apiKey.id, scopes: new Set(apiKey.scopes) }
        : {}),
    },
  };
}

/**
 * Whether an action needs a `financial_event_log` row regardless of its audit
 * trail.
 *
 * Ledger invariant #9 requires one for a locked-period override specifically.
 * The others here are the acts an auditor asks about by name, and keeping the
 * list in one place stops each caller deciding for itself — which is how one
 * of them ends up not writing the row.
 */
export const EVENT_LOGGED_PERMISSIONS: Readonly<Record<string, string>> = {
  'period.override': 'LOCKED_PERIOD_OVERRIDE',
  'period.lock': 'PERIOD_LOCKED',
  'apikey.manage': 'API_KEY_ISSUED',
  'user.manage': 'ROLE_CHANGED',
};

/**
 * Why `BANK_DETAILS_CHANGED` and `RECONCILIATION_COMPLETED` are NOT in the map
 * above, despite being event types this system now writes.
 *
 * The map is keyed by PERMISSION, and its meaning is "every use of this
 * permission logs an event". That holds for `period.override` — there is no way
 * to exercise it quietly. It does not hold for banking: `bank.reconcile`
 * authorises both `completeReconciliation`, which must log, and
 * `suggestForAccount`, which must not. A permission cannot express "this
 * permission, in this operation".
 *
 * So those two are written at their call sites, naming the permission that
 * authorised them, and this map keeps the narrower claim it can actually make.
 */

export function requiresFinancialEvent(permission: Permission): string | undefined {
  return EVENT_LOGGED_PERMISSIONS[permission];
}
