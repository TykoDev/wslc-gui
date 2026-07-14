# Commands, scripts & tests

Every command in the project. All `deno task` invocations run from **`app/`**.

---

## The complete task list

There are seven, defined in [`app/deno.json`](../../app/deno.json). That is the whole set — if it
isn't here, it doesn't exist.

| Task | What it does | Command |
| --- | --- | --- |
| `check` | Typecheck the **backend** | `deno task check` |
| `check:web` | Typecheck the **frontend** | `deno task check:web` |
| `test` | Run the 166 unit tests | `deno task test` |
| `dev:server` | Headless API server on `127.0.0.1:8747` | `deno task dev:server` |
| `dev:web` | Vite dev server (HMR) on `127.0.0.1:5173` | `deno task dev:web` |
| `build:web` | Vite production bundle → `frontend/dist` | `deno task build:web` |
| `compile` | The Windows executable → `dist/wslc-gui.exe` | `deno task compile` |

---

## The full sequence

What CI runs, in order. Run all five before you push.

```powershell
cd app
deno task check       # backend typecheck
deno task test        # 166 tests, ~1s
deno task build:web   # SPA → frontend/dist
deno task check:web   # frontend typecheck
deno task compile     # → dist/wslc-gui.exe
```

> **Both typechecks. Every time.**
>
> `deno task check` covers `main.ts`, `adapter/`, `server/`, `stacks/`, `system/`, `tray/`,
> `tests/` and `scripts/` — **not `frontend/`**. And `build:web` runs Vite, which does not
> typecheck at all.
>
> So without `check:web`, a frontend type error produces a **perfectly green build**. That hole
> was real. Both are now in CI. Keep them there.

---

## Backend

### `deno task check`

```
deno check main.ts adapter/ server/ stacks/ system/ tray/ tests/ scripts/
```

Strict TypeScript across everything except `frontend/`.

### `deno task test`

```
deno test --allow-read --allow-env tests/
```

**166 tests, 17 files, about one second.**

Note the permissions: `--allow-read` and `--allow-env`, and nothing else. **The suite cannot
spawn a process, write a file, or reach the network.** That is deliberate — see
[running the tests](../guides/run-tests.md).

| Variation | Command |
| --- | --- |
| One file | `deno test --allow-read --allow-env tests/validate_test.ts` |
| Filter by name | `deno test --allow-read --allow-env tests/ --filter "buildRunArgs"` |
| Watch | `deno test --allow-read --allow-env --watch tests/` |
| Coverage | `deno test --allow-read --allow-env --coverage=cov tests/` → `deno coverage cov` |
| Stop at first failure | add `--fail-fast` |

### `deno task dev:server`

Runs `server/headless.ts` — the API server with no window. Prints a tokened URL:

```
wslc-gui headless
  UI:    http://127.0.0.1:8747/#t=<64 hex chars>
  API:   http://127.0.0.1:8747/api/capabilities  (Authorization: Bearer <token>)
```

The permission set is scoped, and worth reading as documentation of what the app actually
touches:

```
--allow-net=127.0.0.1,hub.docker.com,registry-1.docker.io,auth.docker.io,ghcr.io,quay.io,mcr.microsoft.com
--allow-run=wsl,wslc,reg,explorer,C:\Program Files\WSL\wslc.exe
--allow-read --allow-write --allow-env --allow-sys=osRelease
```

Overrides: `WSLC_GUI_PORT`, `WSLC_GUI_TOKEN`.

> **The static bundle is snapshotted into memory at startup.** After a `build:web`, restart the
> server or your browser keeps getting the old hashed bundle. This looks exactly like "my change
> didn't apply".

### Hot reload

No task for it, but the flag works:

```powershell
deno run --watch --allow-all server/headless.ts
```

In practice, restarting `dev:server` is faster than reasoning about what the watcher reloaded.

---

## Frontend

### `deno task dev:web`

```
cd frontend && deno install && deno run -A npm:vite
```

Serves the SPA on **`http://127.0.0.1:5173`** with hot module replacement, and proxies `/api`
(including the SSE stream) to the headless server on `8747`. Configured in
[`frontend/vite.config.ts`](../../app/frontend/vite.config.ts).

The task `cd`s into `frontend/` and runs `deno install` for you, so it works from `app/` on a
fresh clone with no setup step.

**You need a token.** Vite doesn't give you one — only the Deno server does. Start `dev:server`
first and open `http://127.0.0.1:5173/#t=<its token>`.

### `deno task build:web`

```
cd frontend && deno install && deno run -A npm:vite build
```

Output → `frontend/dist/` (gitignored; CI rebuilds it). This is what both the headless server and
the compiled exe serve.

### `deno task check:web`

```
cd frontend && deno run -A npm:typescript/tsc -p tsconfig.json --noEmit
```

`tsc` over `frontend/src`. **`deno task check` does not do this.**

`frontend/tsconfig.json` sets `allowImportingTsExtensions` — the repo imports with explicit
`.ts`/`.tsx` extensions and `tsc` has to be told that's fine.

### The scripts in `package.json`

`frontend/package.json` declares `dev` and `build` scripts. **They are not used by this
project's workflow** — there is no npm in the toolchain. The file exists to declare dependencies
for Vite's resolver. Use the Deno commands above.

---

## Packaging

### `deno task compile`

```
deno compile --no-terminal --icon assets/logo.ico
  --include assets/logo.ico
  --include server/worker.ts
  --include tray/tray_worker.ts
  --include system/dialog_worker.ts
  --include frontend/dist
  --allow-ffi --allow-net
  --allow-run=wsl,wslc,reg,explorer,C:\Program Files\WSL\wslc.exe
  --allow-read --allow-write
  --allow-env=WSL_UTF8,WSLC_GUI_TOKEN,WSLC_GUI_PORT,APPDATA,USERPROFILE,TEMP,TMP,LOCALAPPDATA,DENO_DIR,PLUGIN_URL
  --allow-sys=osRelease
  -o dist/wslc-gui.exe main.ts
```

Produces a ~80 MB self-contained executable. Target is `x86_64-pc-windows-msvc` — Deno's only
Windows target. No 32-bit, no ARM.

> **`build:web` first, always.** `compile` embeds `frontend/dist`. Skip it and you ship an exe
> that serves a "Frontend bundle not found" page — and you find out at launch, not at build time.

> **Each Worker needs its own `--include`.** `deno compile` does not embed Workers automatically.
> Forget one and the exe compiles cleanly and then fails at runtime when it tries to spawn that
> worker. There is no compile-time error for this.

### Running the built exe

| Command | Effect |
| --- | --- |
| `.\dist\wslc-gui.exe` | WebView2 window + system tray. |
| `.\dist\wslc-gui.exe --headless` | No window. Serves on `127.0.0.1:8747`, prints a tokened URL. |

`--headless` is the only flag, and it is also the automatic fallback when WebView2 cannot load.

---

## Utility scripts

### `scripts/smoke.ts`

The only script in the project.

```powershell
deno run --allow-run --allow-read --allow-env --allow-sys=osRelease scripts/smoke.ts
```

Exercises the adapter against **your actual machine** and prints a JSON summary:

```jsonc
{
  "capabilities": { "wsl": {…}, "wslcPresent": true, "windows": {…}, "wslSettingsApp": true },
  "distros":   [ { "name": "Ubuntu", "state": "Stopped", "version": 2, "isDefault": true } ],
  "running":   [],
  "statusKeys": ["Default Distribution", "Default Version"],
  "wslconfig": { "path": "C:\\Users\\you\\.wslconfig", "exists": true, "sections": ["wsl2"] },
  "storage":   [ { "name": "Ubuntu", "vhdx": true, "sizeMB": 1234 } ],
  "swap":      { "path": "C:\\…\\Temp\\swap.vhdx", "exists": false }
}
```

**Read-only.** It runs only `wsl`/`reg` queries and `stat`s files — it mutates nothing. It is the
fastest answer to "what does the adapter actually see on this host?", and it is not part of the
test suite precisely because its output depends entirely on the machine.

---

## Testing reference

| Level | Command | Status |
| --- | --- | --- |
| **Unit** | `deno task test` | **166 tests.** Parsers, validators, argument builders, the importer, capability mapping, auth, static serving, config, SSE guards. |
| **Integration** | — | **None.** |
| **E2E** | — | **None.** |
| **Live probe** | `scripts/smoke.ts` | Read-only, host-dependent, not part of CI. |
| **Manual** | [Pre-release checklist](../guides/deploying-to-production.md#pre-release-checklist) | The compiled exe, WebView2 window, tray, native dialogs and real `wsl`/`wslc` calls are verified **by hand**. |

Be honest about that gap. The unit suite does not touch the exe, the window, the tray, the
dialogs, any React component, or a single real `wsl.exe` invocation. The manual checklist is not
optional before a release.

---

## CI

[`.github/workflows/build.yml`](../../.github/workflows/build.yml), on `windows-latest`.
Triggers: push to `master`/`main`, any pull request, any `v*` tag, manual dispatch.

```
actions/checkout@v4
denoland/setup-deno@v2   (deno-version: v2.x)
  → deno task check
  → deno task test
  → deno task build:web
  → deno task check:web
  → deno task compile
  → actions/upload-artifact@v4   (wslc-gui-windows-x86_64, if-no-files-found: error)
  → softprops/action-gh-release@v2   (tags matching v* only)
```

Any red step fails the build and blocks the PR.

---

## Related

- [Running the tests](../guides/run-tests.md) — what each test file covers.
- [Building and releasing](../guides/deploying-to-production.md) — what every compile flag is for.
- [Local development](../getting-started/03-local-development.md) — the two-terminal workflow.
