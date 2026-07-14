// wslc-gui entrypoint. Window mode: main thread owns the webview (run()
// blocks the event loop) and the HTTP server lives in a Worker. Headless
// mode: the server runs directly on the main thread (Deno.serve keeps the
// process alive; a Worker alone would not). Architecture §1.
//
// DLL provisioning (design/spike-webview.md caveat 1): @webview/webview resolves
// webview.dll + WebView2Loader.dll at MODULE LOAD from PLUGIN_URL (or GitHub),
// and copies the loader into the process CWD. We therefore, BEFORE the dynamic
// import: chdir to a writable runtime dir, and when a dll\ folder ships next to
// the exe, pre-place the loader and point PLUGIN_URL at it — fully offline.

import { generateToken } from "./server/auth.ts";

/**
 * The exe is compiled --no-terminal (GUI subsystem). Console children
 * (wsl.exe / reg.exe / wslc.exe) spawned from a console-less GUI process each
 * get a NEW VISIBLE console window — with 8s polling that means constant
 * cmd-window flashing (observed: conhost churn while polling). Deno 2.9.2 has
 * no windowsHide option on Deno.Command, so: allocate ONE console at startup
 * and hide it; all children inherit it and no further windows appear.
 * If a console already exists (launched from a terminal), AllocConsole fails
 * and we deliberately touch nothing.
 */
/** Synchronous sleep (startup path, no event loop to await on). Used to spin briefly
 * while Windows finishes creating the freshly-allocated console window. */
function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer/Atomics unavailable — skip the wait; the retry still runs.
  }
}

function allocHiddenConsole(): void {
  if (Deno.build.os !== "windows") return;
  try {
    const kernel32 = Deno.dlopen("kernel32.dll", {
      AllocConsole: { parameters: [], result: "i32" },
      GetConsoleWindow: { parameters: [], result: "pointer" },
    } as const);
    try {
      if (kernel32.symbols.AllocConsole() !== 0) {
        // GetConsoleWindow can return null in the first moments after AllocConsole
        // (documented Win32 timing). Retry briefly, otherwise the console is left
        // VISIBLE for the whole session — the exact defect this function exists to
        // remove (review r9 M3). ~100ms worst case, only on the null-race path.
        let hwnd = kernel32.symbols.GetConsoleWindow();
        for (let i = 0; i < 50 && hwnd === null; i++) {
          sleepSyncMs(2);
          hwnd = kernel32.symbols.GetConsoleWindow();
        }
        if (hwnd !== null) {
          const user32 = Deno.dlopen("user32.dll", {
            ShowWindow: { parameters: ["pointer", "i32"], result: "i32" },
          } as const);
          user32.symbols.ShowWindow(hwnd, 0); // SW_HIDE
          user32.close();
        }
      }
    } finally {
      kernel32.close();
    }
  } catch {
    // Non-fatal: worst case is the pre-fix flashing behavior.
  }
}
allocHiddenConsole();

/** A UTF-16LE, null-terminated buffer for a Win32 `LPCWSTR` argument. */
function wide(s: string): Uint8Array {
  const u16 = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) u16[i] = s.charCodeAt(i);
  u16[s.length] = 0;
  return new Uint8Array(u16.buffer);
}

/** Native message box. The exe is GUI-subsystem with a hidden console, so this is the
 * ONLY way a startup failure can reach the user — stderr goes to the hidden console and
 * is never seen (review r9 M1/M2). Best-effort: if even this fails there is nothing better. */
function messageBox(text: string, title: string): void {
  if (Deno.build.os !== "windows") {
    console.error(`${title}: ${text}`);
    return;
  }
  try {
    const user32 = Deno.dlopen("user32.dll", {
      MessageBoxW: { parameters: ["pointer", "buffer", "buffer", "u32"], result: "i32" },
    } as const);
    // MB_OK | MB_ICONERROR | MB_SETFOREGROUND
    user32.symbols.MessageBoxW(null, wide(text), wide(title), 0x0 | 0x10 | 0x10000);
    user32.close();
  } catch {
    // nothing better to do
  }
}

/** Fatal startup error: surface it to the user (MessageBox + stderr) and exit non-zero. */
function fatalStartup(text: string): never {
  console.error(text);
  messageBox(text, "WSL Container Manager — startup failed");
  Deno.exit(1);
}

const headless = Deno.args.includes("--headless");
// Env overrides exist for debugging/verification; absent in normal launches.
const token = Deno.env.get("WSLC_GUI_TOKEN") ?? generateToken();
const fixedPort = Number(Deno.env.get("WSLC_GUI_PORT") ?? "0") || 0;

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile;
  } catch {
    return false;
  }
}

/** Writable CWD + local DLL source; must run before importing the webview lib. */
async function prepareWebviewRuntime(): Promise<void> {
  const local = Deno.env.get("LOCALAPPDATA");
  if (local) {
    const runtimeDir = `${local}\\wslc-gui\\runtime`;
    try {
      await Deno.mkdir(runtimeDir, { recursive: true });
      Deno.chdir(runtimeDir);
    } catch {
      // keep original CWD; preload will attempt it instead
    }
  }
  const dllDir = `${dirname(Deno.execPath())}\\dll`;
  if (await fileExists(`${dllDir}\\webview.dll`)) {
    if (Deno.env.get("PLUGIN_URL") === undefined) {
      Deno.env.set("PLUGIN_URL", `file:///${dllDir.replaceAll("\\", "/")}/`);
    }
    // Pre-place the loader so the lib skips its download+delete cycle entirely.
    if (await fileExists(`${dllDir}\\WebView2Loader.dll`) && !(await fileExists("WebView2Loader.dll"))) {
      try {
        await Deno.copyFile(`${dllDir}\\WebView2Loader.dll`, "WebView2Loader.dll");
      } catch {
        // fall back to the lib's own preload
      }
    }
  }
}

function readyLine(port: number): string {
  return `wslc-gui ready: http://127.0.0.1:${port}/#t=${token}`;
}

/** LoadImageW needs a real filesystem path — extract the embedded icon into
 * the (writable) runtime CWD. Returns null when unavailable. */
async function extractTrayIcon(): Promise<string | null> {
  try {
    const bytes = await Deno.readFile(new URL("./assets/logo.ico", import.meta.url));
    await Deno.writeFile("logo.ico", bytes);
    return `${Deno.cwd()}\\logo.ico`;
  } catch {
    return null;
  }
}

if (headless) {
  const { startServer } = await import("./server/start.ts");
  const handle = await startServer({ token, port: fixedPort });
  console.log(readyLine(handle.port));
  console.log("headless mode — open the URL above in a browser (Ctrl+C to stop)");
} else {
  const worker = new Worker(new URL("./server/worker.ts", import.meta.url), { type: "module" });
  // M1 (review r9): a rejection here was an uncaught top-level rejection → the exe exited 1
  // with the reason going only to the hidden console. `fatalStartup` shows it and exits.
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server worker start timeout")), 20_000);
    worker.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "ready") {
        clearTimeout(timer);
        resolve(e.data.port as number);
      } else if (e.data?.type === "error") {
        clearTimeout(timer);
        reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(e.message));
    };
    worker.postMessage({ type: "init", token, port: fixedPort });
  }).catch((err: unknown): never => {
    const detail = err instanceof Error ? err.message : String(err);
    return fatalStartup(
      `Could not start the wslc-gui server.\n\n${detail}\n\n` +
        `Another copy may already be running, or the port may be in use. ` +
        `Close the other instance and try again.`,
    );
  });
  const url = `http://127.0.0.1:${port}/#t=${token}`;
  console.log(readyLine(port));

  // i10 (DD5): minimal post-ready liveness. The startup handlers above only settle the
  // ready/error PROMISE once; after that a server-worker crash would go unheard, leaving a
  // live window talking to a dead server. Re-point the handlers to surface it (no restart
  // supervisor — that is deliberately out of scope).
  worker.onmessage = (e: MessageEvent) => {
    if (e.data?.type === "error") {
      messageBox(
        `The wslc-gui server reported a fatal error and stopped.\n\n${e.data.message}\n\n` +
          `Please restart the app.`,
        "WSL Container Manager — server stopped",
      );
    }
  };
  worker.onerror = (e) => {
    messageBox(
      `The wslc-gui server stopped unexpectedly.\n\n${e.message}\n\nPlease restart the app.`,
      "WSL Container Manager — server stopped",
    );
  };

  try {
    await prepareWebviewRuntime();
    const { SizeHint, Webview } = await import("@webview/webview");
    const webview = new Webview(false, { width: 1280, height: 800, hint: SizeHint.NONE });
    webview.title = "WSL Container Manager";
    webview.navigate(url);

    // System tray (dedicated worker: owns its own Win32 message pump).
    // Failure is never fatal — the app runs tray-less.
    let tray: Worker | null = null;
    try {
      const iconPath = await extractTrayIcon();
      const hwnd = webview.unsafeWindowHandle;
      if (hwnd !== null) {
        // m5: hand the window HWND to the server worker so native file/folder dialogs are
        // owned by (and modal to) the app window instead of appearing behind it.
        worker.postMessage({ type: "hwnd", hwnd: Deno.UnsafePointer.value(hwnd).toString() });
        tray = new Worker(new URL("./tray/tray_worker.ts", import.meta.url), { type: "module" });
        tray.onmessage = (e: MessageEvent) => {
          if (e.data?.type === "error") console.error(`tray failed: ${e.data.message}`);
        };
        tray.postMessage({
          type: "init",
          hwnd: Deno.UnsafePointer.value(hwnd).toString(),
          iconPath,
        });
      }
    } catch (err) {
      console.error(`tray disabled: ${err}`);
    }

    webview.run(); // blocks until the window closes
    try {
      tray?.terminate();
    } catch {
      // already gone
    }
    worker.terminate();
    Deno.exit(0);
  } catch (err) {
    // WebView2 runtime missing or DLL load failure. M2 (review r9): the old fallback kept
    // the server alive but showed NOTHING — no window, no tray, the URL+token only on the
    // hidden console — an invisible, unreachable zombie holding a port. Instead: tell the
    // user, open their browser at the (working) URL, and keep serving so it resolves.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`webview failed (${detail}); server stays up: ${url}`);
    messageBox(
      `The in-app window could not start (the WebView2 runtime may be missing).\n\n${detail}\n\n` +
        `The app is still running. Your browser should open it now; if not, go to:\n${url}`,
      "WSL Container Manager — opening in your browser",
    );
    try {
      // explorer is already in the compile allow-run list; this opens the default browser.
      new Deno.Command("explorer", { args: [url] }).spawn();
    } catch {
      // If the browser can't be launched, the MessageBox still gave the user the URL.
    }
    // A timer op (not a bare pending promise) keeps the event loop — and the server — alive.
    setInterval(() => {}, 2_147_483_647);
  }
}
