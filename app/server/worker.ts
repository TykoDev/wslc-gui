/// <reference lib="deno.worker" />
// Server worker: owns the HTTP server so the main thread can block inside
// webview.run() (architecture §1 — load-bearing topology).

import { startServer, type ServerHandle } from "./start.ts";

let handle: ServerHandle | null = null;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === "init") {
    try {
      handle = await startServer({ token: msg.token, port: msg.port ?? 0 });
      (self as unknown as Worker).postMessage({ type: "ready", port: handle.port });
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: "error", message: String(err) });
    }
  } else if (msg?.type === "hwnd") {
    // m5: the webview HWND arrives after the window is created (main.ts).
    handle?.setOwnerHwnd(typeof msg.hwnd === "string" ? msg.hwnd : null);
  }
};
