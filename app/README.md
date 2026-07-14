# WSL Container Manager (wslc-gui)

A Docker-Desktop-style desktop app for Windows that consolidates the native
`wsl.exe` and `wslc.exe` command surface into one GUI. It invents no commands —
every action maps to a CLI invocation documented in Microsoft's WSL
documentation for `wsl.exe` / `wslc.exe`.

Single compiled executable (Deno + React + WebView2), no runtime dependencies
beyond Windows' own WebView2.

## Pages

- **Containers** — list (running/all), stop / start* / delete* / logs / inspect / exec / prune, live `wslc stats`.
- **Images** — list, pull (explicit verb* or documented auto-pull fallback), inspect, delete*, prune.
- **Resources** — distributions (terminate, set default/version, resize, sparse, move, export, import, unregister),
  storage (real ext4.vhdx paths + sizes from the registry, swap), WSL platform versions, shutdown, disk mount/unmount.
- **Deploy** — Quick run (lazy `wslc run` configurator with live command preview) and Stack mode:
  a compose-subset YAML the app compiles into an ordered `wslc run` plan, deploys sequentially,
  and exports as standard `docker-compose.yaml`.
- **Settings** — light/dark/system theme, polling cadence, and a WSL subpage: launches the native
  WSL Settings app when present, guided `.wslconfig` editor (full documented catalog, Win11-only keys
  gated on Win10, backup-before-write, restart hint).

\* Capability-gated: `container start/rm`, explicit `pull`, `image rm` are proven via the WSL container
API but not documented as CLI verbs; the app enables them only when `wslc --help` on the host actually
lists them. On hosts without wslc entirely (e.g. Windows 10 + stable WSL 2.7.x as of 2026-07), the
Containers/Images/Deploy pages show an explicit "unavailable" state and Resources/Settings stay fully functional.

## Requirements

- Windows 10 19041+ (Win11 for some `.wslconfig` keys, annotated in-app)
- WSL 2 installed (`wsl --update` recommended; wslc requires a WSL release that ships it)
- WebView2 runtime (ships with Edge; app falls back to `--headless` + browser if missing)

## Development

```powershell
deno task dev:server   # headless API server on 127.0.0.1:8747 (prints tokened URL)
deno task dev:web      # Vite dev server on 5173, proxying /api -> 8747 (run in a second terminal)
deno task test         # unit tests (parsers, validators, run-arg builder, wslconfig, stack compiler)
deno task check        # typecheck backend
deno task check:web    # typecheck frontend (check does NOT cover frontend/)
```

Open the Vite server at `http://127.0.0.1:5173/#t=<token from dev:server>` — that fragment carries
the session token, and without it every API call returns 401.

## Build & package

```powershell
deno task build:web    # vite build -> frontend/dist
deno task compile      # -> dist/wslc-gui.exe (embeds SPA + server; --no-terminal GUI subsystem)
```

Release layout (offline-capable):

```
dist/
├─ wslc-gui.exe
└─ dll/
   ├─ webview.dll          # pinned webview_deno 0.9.0 release artifacts
   └─ WebView2Loader.dll   # main.ts points PLUGIN_URL at this folder before loading the webview
```

Without `dll/`, first launch downloads the two DLLs from the webview_deno GitHub release (network required once).
`wslc-gui.exe --headless` serves the UI for any browser instead of opening a window.

## Security model (summary — full model in the run's design/security.md)

- Server binds 127.0.0.1 only; every `/api` call requires the per-launch session token
  (delivered via URL fragment); foreign `Origin` → 403; mutations require JSON content-type.
- One child-process choke point with a binary allowlist (`wsl`, `wslc`, `reg`, `explorer`) mirrored
  by the compile-time `--allow-run` list; args arrays only (no shell), all user input validated,
  leading-dash arguments rejected (flag injection).
- Destructive operations are double-gated: typed-name confirmation in the UI **and** server-side
  `confirmName`/`confirm` echoes for unregister / WSL shutdown.
- `.wslconfig` writes create a timestamped backup first and preserve unknown keys/comments.
