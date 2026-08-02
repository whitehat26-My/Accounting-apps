/**
 * The API client: one fetch wrapper the whole app goes through.
 *
 * Three responsibilities, and deliberately no more:
 *
 * 1. Attach the session — bearer token and X-Tenant-Id — from the store.
 * 2. On a 401, spend the refresh token once via /auth/switch (rotation:
 *    the old refresh token dies, the response carries its successor),
 *    replay the request, and give up honestly if that also fails.
 * 3. Stamp every write with an Idempotency-Key, because the API requires
 *    one and a double-clicked button is exactly the failure it prevents.
 *
 * Amounts stay STRINGS end to end. This file is the place someone would
 * reach for parseFloat; it is named here so they reach for the comment
 * instead. Display formatting is `display.ts`; arithmetic happens on the
 * server, in Money.
 */

export interface Session {
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly tenantId: string;
  readonly organisationName: string;
}

const KEY = 'emil.session';

export function loadSession(): Session | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  window.localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
  window.localStorage.removeItem(KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body['message'] === 'string' ? (body['message'] as string) : `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly body?: unknown;
  /** Skip the session entirely — login, register, onboarding. */
  readonly anonymous?: boolean;
}

export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const attempt = async (): Promise<Response> => {
    const session = options.anonymous ? null : loadSession();
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (session) {
      headers['authorization'] = `Bearer ${session.accessToken}`;
      headers['x-tenant-id'] = session.tenantId;
    }
    if (options.method === 'POST' || options.method === 'PATCH') {
      headers['idempotency-key'] = crypto.randomUUID();
    }

    return fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  };

  let response = await attempt();

  if (response.status === 401 && !options.anonymous) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      clearSession();
      window.location.href = '/login';
      throw new ApiError(401, { message: 'Session expired' });
    }
    response = await attempt();
  }

  const body = response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>);
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

/**
 * Spend the refresh token for a new access token. Serialised through one
 * in-flight promise: two 401s racing would otherwise both spend the same
 * refresh token, and rotation makes the second spend a reuse — which the
 * server treats as theft and answers by revoking the whole session family.
 */
let refreshing: Promise<boolean> | null = null;

function refreshAccessToken(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const session = loadSession();
      if (!session) return false;

      const response = await fetch('/api/v1/auth/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          refreshToken: session.refreshToken,
          tenantId: session.tenantId,
        }),
      });
      if (!response.ok) return false;

      const body = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      saveSession({
        ...session,
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
      });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Fetch a binary document (a PDF) with the session attached, and hand back an
 * object URL. A plain <a href> cannot carry the Authorization header, so
 * "Print receipt" fetches the bytes and opens the blob — same authentication
 * path as every other request, no token in any URL.
 */
export async function apiBlobUrl(path: string): Promise<string> {
  const session = loadSession();
  const response = await fetch(`/api${path}`, {
    headers: session
      ? { authorization: `Bearer ${session.accessToken}`, 'x-tenant-id': session.tenantId }
      : {},
  });
  if (!response.ok) throw new ApiError(response.status, { message: `Document failed (${response.status})` });
  return URL.createObjectURL(await response.blob());
}
