// Token handling + fetch wrapper. Token arrives once via URL fragment from
// the exe shell; kept tab-scoped (sessionStorage) so dev reloads survive.
// The fragment is stripped from the address bar immediately.

let token = "";

export function initToken(): void {
  const m = location.hash.match(/t=([A-Za-z0-9_-]{8,})/);
  if (m) {
    token = m[1];
    sessionStorage.setItem("wslc-t", token);
    history.replaceState(null, "", location.pathname || "/");
  } else {
    token = sessionStorage.getItem("wslc-t") ?? "";
  }
}

export function hasToken(): boolean {
  return token.length > 0;
}

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
  get detail(): string {
    const parts = [
      typeof this.body.detail === "string" ? this.body.detail : "",
      typeof this.body.stderr === "string" ? this.body.stderr : "",
      typeof this.body.hint === "string" ? this.body.hint : "",
    ].filter((s) => s.length > 0);
    return parts.join("\n") || this.message;
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON error body
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function sseUrl(): string {
  return `/api/events?t=${encodeURIComponent(token)}`;
}
