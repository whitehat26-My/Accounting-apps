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
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Skip the session entirely — login, register, onboarding. */
  readonly anonymous?: boolean;
}

/**
 * NEXT_PUBLIC_DEMO=1 swaps the transport for the in-browser demo backend so
 * the screens can live on a static host (GitHub Pages). Checked at build time:
 * in a real build the demo module is never even imported.
 */
const DEMO = process.env['NEXT_PUBLIC_DEMO'] === '1';

export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  if (DEMO) {
    const { demoApi } = await import('./demo');
    try {
      return demoApi(path, options.method ?? 'GET', options.body) as T;
    } catch (e) {
      const err = e as { status?: number; body?: Record<string, unknown> };
      throw new ApiError(err.status ?? 500, err.body ?? { message: String(e) });
    }
  }

  const attempt = async (): Promise<Response> => {
    const session = options.anonymous ? null : loadSession();
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (session) {
      headers['authorization'] = `Bearer ${session.accessToken}`;
      headers['x-tenant-id'] = session.tenantId;
    }
    // Every mutating method, DELETE included — the API's idempotency
    // interceptor treats POST, PUT, PATCH and DELETE alike and refuses any of
    // them without a key.
    if (options.method === 'POST' || options.method === 'PATCH' || options.method === 'DELETE') {
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
 *
 * Takes an optional body, because not every document is a stored one fetched
 * by id: a payslip is rendered from figures that must travel in a POST body,
 * since a salary in a query string ends up in every proxy's access log between
 * here and the shop PC.
 */
/**
 * Download a document under the name the SERVER gave it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AND `apiBlobUrl` IS NOT ENOUGH.
 *
 * A blob URL carries no filename. `apiBlobUrl` + `window.open` therefore
 * throws away the `content-disposition` the API carefully built, and the
 * browser invents its own — so a month of payslips saves as `download (3).pdf`
 * and the shop cannot tell one from another. Opening in a tab is right for
 * something you glance at; a document you keep needs its name.
 *
 * The object URL is revoked once the click has been dispatched. `apiBlobUrl`
 * never revokes, which leaks one blob per print for the life of the page.
 * ---------------------------------------------------------------------------
 */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  if (DEMO) {
    const { DEMO_PDF_MESSAGE } = await import('./demo');
    throw new ApiError(501, { message: DEMO_PDF_MESSAGE });
  }
  const session = loadSession();
  const response = await fetch(`/api${path}`, {
    headers: session
      ? { authorization: `Bearer ${session.accessToken}`, 'x-tenant-id': session.tenantId }
      : {},
  });
  if (!response.ok) {
    throw new ApiError(response.status, { message: `Document failed (${response.status})` });
  }

  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFrom(response.headers.get('content-disposition')) ?? fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // A revoke in the same tick would race Safari's download; one frame is
    // enough, and the blob is freed either way.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** `attachment; filename="payslips-2026-08.pdf"` → `payslips-2026-08.pdf`. */
function filenameFrom(disposition: string | null): string | null {
  const match = disposition?.match(/filename="?([^";]+)"?/);
  return match?.[1] ?? null;
}

export async function apiBlobUrl(path: string, body?: unknown): Promise<string> {
  if (DEMO) {
    const { DEMO_PDF_MESSAGE } = await import('./demo');
    throw new ApiError(501, { message: DEMO_PDF_MESSAGE });
  }
  const session = loadSession();
  const headers: Record<string, string> = session
    ? { authorization: `Bearer ${session.accessToken}`, 'x-tenant-id': session.tenantId }
    : {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = crypto.randomUUID();
  }
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new ApiError(response.status, { message: `Document failed (${response.status})` });

  /*
   * 204 is a SUCCESS with nothing in it, and `URL.createObjectURL` will
   * happily mint a URL for zero bytes — which every caller then hands to an
   * <img> or a new tab, and gets a broken image or a blank page. Caught here
   * because no caller wants a URL to nothing: "there is no document" is a
   * rejection, the same as any other reason there is no document.
   */
  const blob = await response.blob();
  if (blob.size === 0) {
    throw new ApiError(204, { message: 'There is nothing here yet.' });
  }
  return URL.createObjectURL(blob);
}
