// Session-token + origin guards (design/security.md §2).

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export type AuthResult = { ok: true } | { ok: false; status: number; reason: string };

export function checkAuth(req: Request, token: string, ownOrigin: string): AuthResult {
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== ownOrigin) {
    return { ok: false, status: 403, reason: "foreign origin" };
  }
  const url = new URL(req.url);
  const header = req.headers.get("authorization");
  let presented: string | null = null;
  if (header?.startsWith("Bearer ")) {
    presented = header.slice(7).trim();
  } else if (url.pathname === "/api/events") {
    // EventSource cannot set an Authorization header, so the SSE route — and ONLY the SSE
    // route — accepts the token as a query param (r10 I1). Every other route requires the
    // header, so a token leaked into a logged/copied URL is not a usable credential for them.
    presented = url.searchParams.get("t");
  }
  if (presented === null || !constantTimeEqual(presented, token)) {
    return { ok: false, status: 401, reason: "missing or invalid token" };
  }
  return { ok: true };
}

/** Mutations must be JSON (kills HTML-form CSRF). */
export function requireJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  return ct.toLowerCase().startsWith("application/json");
}
