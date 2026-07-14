// Headless mode: server on the main thread, URL printed for a browser.
// Used for development, rendered-verification evidence, and as the fallback
// shell when the WebView2 runtime is unavailable (decision D3 fallback).

import { generateToken } from "./auth.ts";
import { startServer } from "./start.ts";

const token = Deno.env.get("WSLC_GUI_TOKEN") ?? generateToken();
const port = Number(Deno.env.get("WSLC_GUI_PORT") ?? "8747");
const handle = await startServer({ token, port });

console.log(`wslc-gui headless`);
console.log(`  UI:    http://127.0.0.1:${handle.port}/#t=${token}`);
console.log(`  API:   http://127.0.0.1:${handle.port}/api/capabilities  (Authorization: Bearer <token>)`);
