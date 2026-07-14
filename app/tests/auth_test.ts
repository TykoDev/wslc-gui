import { assertEquals } from "@std/assert";
import { checkAuth, generateToken, requireJson } from "../server/auth.ts";

const TOKEN = "a".repeat(64);
const ORIGIN = "http://127.0.0.1:8888";

function req(headers: Record<string, string> = {}, url = `${ORIGIN}/api/x`): Request {
  return new Request(url, { headers });
}

Deno.test("checkAuth: missing token → 401", () => {
  const r = checkAuth(req(), TOKEN, ORIGIN);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 401);
});

Deno.test("checkAuth: wrong token → 401; length-mismatched token → 401", () => {
  for (const bad of ["Bearer nope", `Bearer ${"b".repeat(64)}`, `Bearer ${TOKEN}x`]) {
    const r = checkAuth(req({ authorization: bad }), TOKEN, ORIGIN);
    assertEquals(r.ok, false);
  }
});

Deno.test("checkAuth: valid bearer token → ok", () => {
  assertEquals(checkAuth(req({ authorization: `Bearer ${TOKEN}` }), TOKEN, ORIGIN).ok, true);
});

Deno.test("checkAuth: foreign origin rejected BEFORE token check → 403", () => {
  const r = checkAuth(
    req({ authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" }),
    TOKEN,
    ORIGIN,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 403);
});

Deno.test("checkAuth: own origin accepted", () => {
  assertEquals(checkAuth(req({ authorization: `Bearer ${TOKEN}`, origin: ORIGIN }), TOKEN, ORIGIN).ok, true);
});

Deno.test("checkAuth: SSE query-param token accepted (EventSource cannot set headers)", () => {
  assertEquals(checkAuth(req({}, `${ORIGIN}/api/events?t=${TOKEN}`), TOKEN, ORIGIN).ok, true);
  assertEquals(checkAuth(req({}, `${ORIGIN}/api/events?t=wrong`), TOKEN, ORIGIN).ok, false);
});

Deno.test("checkAuth: query-param token is REJECTED on any route but /api/events (I1)", () => {
  // A token leaked into a copied/logged URL must not authenticate a real API call — only SSE
  // (which physically cannot send a header) may use ?t=.
  for (const path of ["/api/containers", "/api/run", "/api/config", "/api/events/extra"]) {
    const r = checkAuth(req({}, `${ORIGIN}${path}?t=${TOKEN}`), TOKEN, ORIGIN);
    assertEquals(r.ok, false, path);
    if (!r.ok) assertEquals(r.status, 401, path);
  }
  // The header still works on those routes.
  assertEquals(checkAuth(req({ authorization: `Bearer ${TOKEN}` }, `${ORIGIN}/api/containers`), TOKEN, ORIGIN).ok, true);
});

Deno.test("generateToken: 64 hex chars, unique per call", () => {
  const a = generateToken();
  const b = generateToken();
  assertEquals(/^[0-9a-f]{64}$/.test(a), true);
  assertEquals(a === b, false);
});

Deno.test("requireJson: only application/json passes", () => {
  const mk = (ct?: string) => new Request("http://x/", { method: "POST", headers: ct ? { "content-type": ct } : {} });
  assertEquals(requireJson(mk("application/json")), true);
  assertEquals(requireJson(mk("application/json; charset=utf-8")), true);
  assertEquals(requireJson(mk("text/plain")), false);
  assertEquals(requireJson(mk()), false);
});
