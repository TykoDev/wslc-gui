// Embedded SPA serving. Files are loaded once into an in-memory map keyed by
// normalized URL path — traversal cannot escape a Map lookup (security.md §4).

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticStore {
  files: Map<string, { bytes: Uint8Array; type: string }>;
  hasIndex: boolean;
}

async function loadDir(store: StaticStore, fsDir: string, urlPrefix: string): Promise<void> {
  for await (const entry of Deno.readDir(fsDir)) {
    const fsPath = `${fsDir}/${entry.name}`;
    const urlPath = `${urlPrefix}/${entry.name}`;
    if (entry.isDirectory) {
      await loadDir(store, fsPath, urlPath);
    } else if (entry.isFile) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      store.files.set(urlPath, {
        bytes: await Deno.readFile(fsPath),
        type: TYPES[ext] ?? "application/octet-stream",
      });
    }
  }
}

export async function loadStatic(distDir: string): Promise<StaticStore> {
  const store: StaticStore = { files: new Map(), hasIndex: false };
  try {
    await loadDir(store, distDir, "");
    store.hasIndex = store.files.has("/index.html");
  } catch {
    // dist not present (dev without build) — handled by fallback page
  }
  return store;
}

const FALLBACK = `<!doctype html><meta charset="utf-8"><title>wslc-gui</title>
<body style="font-family:system-ui;padding:2rem;background:#111;color:#eee">
<h2>Frontend bundle not found</h2>
<p>Run <code>deno task build:web</code>, or use the Vite dev server (<code>deno task dev:web</code>).</p>`;

// I2: defense-in-depth for the token-in-hash. `default-src 'self'` plus the locked
// fetch/img/form sinks (connect/img/font/object/base/form-action) mean a compromised
// renderer cannot exfiltrate the token to an external host, nor load external code. The
// shipped index.html carries an inline theme-prepaint <script>, so script/style keep
// 'unsafe-inline'; the exfiltration channels are the ones this actually closes.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/** Headers for an HTML document response (the SPA shell / fallback). */
function htmlHeaders(cacheControl: string): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": cacheControl,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
  };
}

export function serveStatic(store: StaticStore, pathname: string): Response {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (path.includes("..") || path.includes("\\")) {
    return new Response("not found", { status: 404 });
  }
  if (path === "/") path = "/index.html";
  const hit = store.files.get(path);
  if (hit) {
    // The SPA document (index.html) carries the full CSP; other assets keep nosniff.
    if (path === "/index.html") {
      return new Response(hit.bytes.slice(), { headers: htmlHeaders("no-cache") });
    }
    return new Response(hit.bytes.slice(), {
      headers: {
        "content-type": hit.type,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }
  // SPA history-router fallback: any unknown non-asset path gets index.html.
  if (!path.includes(".") && store.hasIndex) {
    const index = store.files.get("/index.html")!;
    return new Response(index.bytes.slice(), { headers: htmlHeaders("no-cache") });
  }
  if (!store.hasIndex && (path === "/index.html" || !path.includes("."))) {
    return new Response(FALLBACK, { headers: htmlHeaders("no-cache") });
  }
  return new Response("not found", { status: 404 });
}
