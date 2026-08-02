export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type ApiResult<T> = { status: number; data: T };

/**
 * Same-origin `/api/...` JSON helper. Surfaces `{ error }` from non-OK bodies.
 * No auth headers.
 */
export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(path, { ...init, headers });
  let body: { error?: string } & Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (!res.ok) {
    throw new ApiError(res.status, body.error || res.statusText || 'request failed');
  }

  return { status: res.status, data: body as T };
}

export async function apiText(path: string): Promise<string> {
  const res = await fetch(path);
  const text = await res.text();
  if (!res.ok) {
    let message = text || res.statusText || 'request failed';
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // plain-text error body
    }
    throw new ApiError(res.status, message);
  }
  return text;
}
