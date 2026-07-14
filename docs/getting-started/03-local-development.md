# 3. Local development

Everything you need to run the app from source, iterate on it with hot reload, and build the
executable.

---

## Prerequisites

| Software | Version | Notes |
| --- | --- | --- |
| **Deno** | 2.9+ | The only hard requirement. [deno.com](https://deno.com/) — `winget install DenoLand.Deno`. Developed against 2.9.2 (`x86_64-pc-windows-msvc`). |
| **Git** | any | |
| **Windows** | 10 build 19041+ | The app is Windows-only: it calls Win32 via FFI and shells out to `wsl.exe`. |
| **WSL 2** | any | Needed to exercise anything real. |
| **`wslc`** | a WSL release that ships it | Optional. Without it the Containers/Images/Deploy pages show their "unavailable" state — which is itself worth testing. |

**You do not need Node.js or npm.** Deno runs Vite and TypeScript directly through `npm:`
specifiers. There is a `frontend/package.json`, but it exists to declare dependencies for
Vite's resolver, not to be installed by npm.

### Editor setup

**VS Code** with the official [Deno extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno).

Point it at `app/deno.json` and you get type-checking, JSR module resolution and formatting
for the backend. A workspace `.vscode/settings.json` like this is enough:

```json
{
  "deno.enable": true,
  "deno.config": "./app/deno.json",
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "denoland.vscode-deno"
}
```

(`.vscode/` is gitignored, so this stays yours.)

Two things to know about the split:

- The **backend** (`main.ts`, `adapter/`, `server/`, `stacks/`, `system/`, `tray/`, `tests/`,
  `scripts/`) is Deno-native and type-checked by `deno task check`.
- The **frontend** (`frontend/src/`) is ordinary React/TypeScript, type-checked by `tsc` via
  `deno task check:web`. **`deno task check` does not cover it.** Run both.

Useful extensions: **ESLint** is not configured here (Deno's own linter covers the backend);
**Error Lens** and the **React** snippets pack are nice-to-haves.

---

## Clone and orient

```powershell
git clone https://github.com/TykoDev/wslc-gui.git
cd wslc-gui\app
```

Everything below runs from `app/` unless it says otherwise. There is no install step for the
backend — Deno fetches and caches JSR modules on first run, pinned by `deno.lock`.

---

## Backend development

The backend is a Deno HTTP server. **There is no database, no ORM and no migrations** — all
state is either read live from `wsl.exe`/`wslc.exe`/the Windows registry, or kept in two small
JSON files under `%APPDATA%\wslc-gui\`.

### Run the API server

```powershell
deno task dev:server
```

This starts `server/headless.ts` — the server on its own, no window — and prints:

```
wslc-gui headless
  UI:    http://127.0.0.1:8747/#t=<64-hex-char token>
  API:   http://127.0.0.1:8747/api/capabilities  (Authorization: Bearer <token>)
```

Open the **UI** line in a browser and you have the whole app, served from `frontend/dist`.

Hit the API directly with the token:

```powershell
$t = "<paste the token>"
curl.exe -H "Authorization: Bearer $t" http://127.0.0.1:8747/api/capabilities
```

### Hot reload

Deno has a built-in watcher. There is no task for it, but the flag works on any task:

```powershell
deno run --watch --allow-all server/headless.ts
```

For day-to-day work, restarting `dev:server` is usually faster than reasoning about which
module the watcher reloaded — the server starts in well under a second.

> **The one that will get you.** The headless server loads `frontend/dist` into memory **once,
> at startup**. After a `deno task build:web`, you *must* restart the server or the browser
> keeps being served the previous hashed bundle. This looks exactly like "my change didn't
> apply". It did; you're being served the old file.

### Fixing a stuck port

`dev:server` uses a fixed port (8747) so the Vite proxy has something stable to point at. A
leftover Deno process from a previous session will hold it. Either kill it, or move:

```powershell
$env:WSLC_GUI_PORT = "8750"; deno task dev:server
```

You can also pin the token, which is handy when you want a URL you can keep pasting:

```powershell
$env:WSLC_GUI_TOKEN = "dev"; deno task dev:server
```

Both are debugging affordances. Normal launches generate a fresh 256-bit token and, in window
mode, take an ephemeral port.

### Probe the real machine

```powershell
deno run --allow-run --allow-read --allow-env --allow-sys=osRelease scripts/smoke.ts
```

`scripts/smoke.ts` runs the adapter against *your* host and prints a JSON summary:
capabilities, distros, `.wslconfig` sections, VHDX sizes, swap. **It is read-only** — it never
mutates anything. It is the fastest way to answer "what does the adapter actually see here?"

### Debugging

Deno speaks the Chrome DevTools protocol:

```powershell
deno run --inspect-brk --allow-all server/headless.ts
```

Then attach from VS Code (`Debug: Attach to Node Process` works — pick the Deno process) or
open `chrome://inspect` in Edge/Chrome. Breakpoints in `.ts` sources work directly.

---

## Frontend development

React 19 + Vite 7 + TypeScript, in `app/frontend/`.

### Run the dev server

```powershell
deno task dev:web
```

That serves the SPA on **`http://127.0.0.1:5173`** with hot module replacement, and proxies
`/api` and `/api/events` (SSE) through to the headless server on **8747** — configured in
[`frontend/vite.config.ts`](../../app/frontend/vite.config.ts).

The task `cd`s into `frontend/` and runs `deno install` itself, so it works from `app/` on a fresh
clone with no separate setup step.

### The token in dev

The Vite dev server on 5173 does **not** hand you a token — only the Deno server does. So:

1. Start `deno task dev:server` and copy the `#t=…` fragment from its printed URL.
2. Open `http://127.0.0.1:5173/#t=<that token>`.

The SPA reads the fragment once, stashes it in `sessionStorage`, and strips it from the
address bar. Reloads then work without re-pasting — the token survives in the tab.

If you skip this, every API call 401s and the top bar shows a `no session token` pill.

### Production bundle

```powershell
deno task build:web    # from app/ — runs `deno install` then `vite build`
```

Output lands in `frontend/dist/`, which is what both the headless server and the compiled exe
serve. (It is gitignored — CI rebuilds it.)

### Browser DevTools

Nothing special. The React app is a normal SPA. The two things worth knowing:

- **Network → `/api/events`** is the SSE stream. Open it and you can watch `containers`,
  `resources`, `images`, `volumes` and `capabilities` snapshot frames arrive, plus a `:hb`
  heartbeat comment every 25 s. If snapshots stop, that stream is where you'll see it.
- There is **no frontend environment configuration**. No `.env`, no `VITE_*` variables. The
  API base is always same-origin `/api`, and the only runtime input is the token from the URL
  fragment.

---

## Full-stack development

Two terminals, both from `app/`:

```powershell
# Terminal 1 — API on 8747
deno task dev:server
```

```powershell
# Terminal 2 — SPA with HMR on 5173, proxying /api → 8747
deno task dev:web
```

Browse to `http://127.0.0.1:5173/#t=<token from terminal 1>`.

Edit anything under `frontend/src/` and it hot-reloads. Edit anything in the backend and
restart terminal 1.

### Which URL am I supposed to use?

| URL | What it is | Use for |
| --- | --- | --- |
| `:5173` | Vite dev server, proxying to `:8747` | **Frontend work.** HMR, source maps, fast. |
| `:8747` | Deno server serving the built `frontend/dist` | **Backend work,** and verifying the real production path. |

They are not interchangeable. `:5173` serves your working tree; `:8747` serves whatever
`build:web` last produced.

### CORS and origins

There is nothing to configure. The Vite proxy is set with `changeOrigin: false`, so requests
arrive at the Deno server carrying the browser's own `Origin`. The server's rule is: if an
`Origin` header is present it must equal the server's own origin, otherwise 403.

In dev that means the proxy path works and a page on any *other* origin is rejected — which is
exactly the CSRF control the app relies on in production. You are testing the real thing, not a
relaxed dev variant.

---

## Before you push

Run all five. CI runs exactly these, in this order, and will fail your PR on any of them.

```powershell
deno task check       # typecheck backend
deno task test        # 166 unit tests
deno task build:web   # frontend production bundle
deno task check:web   # typecheck frontend (tsc)
deno task compile     # the exe itself
```

> **Both typechecks, every time.** `deno task check` covers `main.ts` and `adapter/`,
> `server/`, `stacks/`, `system/`, `tray/`, `tests/`, `scripts/` — but **not `frontend/`**. And
> `build:web` runs Vite, which does not typecheck. So without `check:web`, a frontend type
> error produces a perfectly green build. Both holes were real; both are now closed in CI.
> Keep them closed locally too.

---

## Troubleshooting

**My frontend change isn't showing up on `:8747`.**
You rebuilt but didn't restart the server. The static bundle is snapshotted into memory at
startup. Restart `dev:server`.

**`Address already in use` on 8747.**
A leftover `deno` process. `Get-Process deno | Stop-Process`, or set `WSLC_GUI_PORT`.

**Every API call returns 401.**
No token. Open the app via the `#t=…` URL the server printed, not a bare `http://127.0.0.1:5173/`.

**Every API call returns 403.**
A foreign `Origin` reached the server. You are almost certainly hitting `:8747` from a page
served on a different origin without the proxy.

**`/api/containers` returns 503 `wslc_unavailable`.**
There is no `wslc` on this host. That is a correct answer, not a bug. `wsl --update`, then
click **Re-check** in the UI (the capability probe is cached for 60 s).

**A command returns 409 `verb_unavailable`.**
Your `wslc` build does not advertise that verb in its `--help`. The app refuses to emit a
command it cannot prove exists. Check what it *did* detect:

```powershell
curl.exe -H "Authorization: Bearer $t" http://127.0.0.1:8747/api/capabilities
```

The `wslc.can`, `wslc.containerVerbs`, `wslc.volumeVerbs` and `wslc.runFlags` fields are the
whole truth about what your host supports.

**A console window flashes while the app polls.**
That was a real bug, and it is fixed — but only in the *compiled* exe, which allocates one
hidden console at startup so child processes inherit it. If you see it, you are running from
source in a context without a console. Harmless.

**Type errors in `frontend/` that Deno doesn't see.**
Expected. Run `deno task check:web`. Note that `frontend/tsconfig.json` sets
`allowImportingTsExtensions` — this repo imports with explicit `.ts`/`.tsx` extensions, and
`tsc` needs to be told that is fine.

### Where to look when something is wrong

There is **no log file**. The app is a foreground process:

- **Headless / from source** — everything goes to the terminal's stdout/stderr.
- **The compiled exe** — the console is allocated and *hidden* at startup, so stderr goes
  nowhere you can see. This is deliberate (otherwise every polled child process would flash a
  window). It is also why fatal startup errors are surfaced as native **message boxes** instead
  — that is the only channel that can reach you.

To get logs out of a compiled build, run it with `--headless` from a terminal.

---

**You're set up.** Next, depending on what you're doing:
[run the tests](../guides/run-tests.md) · [build a release](../guides/deploying-to-production.md) · [understand the architecture](../concepts/architectural-overview.md)
