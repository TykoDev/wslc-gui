// Shared server bootstrap used by both the worker (webview mode) and
// headless mode. Binds 127.0.0.1 ONLY (security §2.1).

import { checkAuth, requireJson } from "./auth.ts";
import { loadStatic, serveStatic } from "./static.ts";
import { handleApi, type RouteCtx } from "./routes.ts";
import { EventHub } from "./sse.ts";
import { loadConfig } from "./app_config.ts";

export interface ServerHandle {
  port: number;
  shutdown: () => Promise<void>;
  /** m5: set the webview HWND (as a decimal string) once the window exists, so native
   * dialogs opened via /api/system/pick are owned by (and modal to) the app window. */
  setOwnerHwnd: (hwnd: string | null) => void;
}

export async function startServer(opts: { token: string; port?: number }): Promise<ServerHandle> {
  const distDir = `${import.meta.dirname}/../frontend/dist`;
  const staticStore = await loadStatic(distDir);
  const config = { current: await loadConfig() };
  const hub = new EventHub(() => config.current);
  // m5: a mutable box the dialog route reads; the webview HWND arrives after startup.
  const ownerHwnd: { value: string | null } = { value: null };
  const ctx: RouteCtx = { hub, config, ownerHwnd };

  let ownOrigin = "";

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: opts.port ?? 0 },
    async (req, info) => {
      // Defense in depth — the bind already guarantees loopback.
      const remote = info.remoteAddr as Deno.NetAddr;
      if (remote.hostname !== "127.0.0.1") {
        return new Response("forbidden", { status: 403 });
      }
      const url = new URL(req.url);

      if (url.pathname.startsWith("/api")) {
        const auth = checkAuth(req, opts.token, ownOrigin);
        if (!auth.ok) {
          return new Response(JSON.stringify({ error: auth.reason }), {
            status: auth.status,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/api/events") {
          return hub.handleRequest(req);
        }
        if (req.method !== "GET" && !requireJson(req)) {
          return new Response(JSON.stringify({ error: "json required" }), {
            status: 415,
            headers: { "content-type": "application/json" },
          });
        }
        return await handleApi(req, url, ctx);
      }

      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return serveStatic(staticStore, url.pathname);
    },
  );

  ownOrigin = `http://127.0.0.1:${server.addr.port}`;
  hub.start();

  return {
    port: server.addr.port,
    shutdown: async () => {
      hub.stop();
      await server.shutdown();
    },
    setOwnerHwnd: (hwnd) => {
      ownerHwnd.value = hwnd;
    },
  };
}
