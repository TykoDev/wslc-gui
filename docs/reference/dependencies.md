# Dependencies

The dependency list is short on purpose. Every entry below earns its place, and the reasoning for
each is given — because the cheapest dependency is the one you didn't add.

**There is no Python. There is no Node.js runtime requirement. There is no database driver.**

---

## Runtime

| | Version | Notes |
| --- | --- | --- |
| **Deno** | **2.9+** | The only toolchain requirement. Developed and tested against **2.9.2** (`x86_64-pc-windows-msvc`). |
| **Windows** | 10 build 19041+ | The app is Windows-only by nature — it calls Win32 through FFI and shells out to `wsl.exe`. |
| **WebView2** | Evergreen | Ships with Edge. Optional: without it the app falls back to `--headless` + browser. |

Deno also supplies the frontend toolchain through `npm:` specifiers. **You never run `npm
install`.**

---

## Backend — JSR

Declared in [`app/deno.json`](../../app/deno.json), locked by `deno.lock`.

### Direct

| Package | Version | Purpose | Docs |
| --- | --- | --- | --- |
| `@webview/webview` | **0.9.0** (exact) | The native desktop window. Binds WebView2 through FFI. | [jsr.io/@webview/webview](https://jsr.io/@webview/webview) |
| `@std/yaml` | `1` | Parse and stringify YAML — the stack schema, compose import, Kubernetes manifests, and the `docker-compose.yaml` export. | [jsr.io/@std/yaml](https://jsr.io/@std/yaml) |
| `@std/assert` | `1` | Test assertions. **Dev only** — never imported by shipping code. | [jsr.io/@std/assert](https://jsr.io/@std/assert) |

**Three direct dependencies. That's the whole backend.**

**Why `@webview/webview`?** It is the only maintained way to get a WebView2 window from Deno.
The alternatives were Tauri or Electron, which both mean adopting a second toolchain (Rust, or
Node + Chromium) and shipping a browser engine. This binds the one Windows already has.

**It is pinned to an exact version, not a range.** The library resolves `webview.dll` and
`WebView2Loader.dll` **at module load**, and the DLLs shipped in `dist/dll/` must match the
library that loads them. A caret range here would silently break offline launches. See
[the release layout](../guides/deploying-to-production.md#the-release-layout).

**Why `@std/yaml` and not a hand-rolled parser?** Multi-document Kubernetes manifests, anchors,
block scalars. Writing that yourself is how you get a subtly wrong parser that fails on someone's
real file.

### Transitive

Pulled in by `@webview/webview`, and locked:

| Package | Why it's here |
| --- | --- |
| `@denosaurs/plug` | Fetches and caches the native DLLs. |
| `@std/path` · `@std/fs` · `@std/encoding` · `@std/fmt` · `@std/internal` | Standard-library support for `plug`. |

Everything comes from **JSR** or the **Deno standard library**. There is no npm package in the
backend at all.

---

## Frontend — npm (via Deno)

Declared in [`app/frontend/package.json`](../../app/frontend/package.json).

### Runtime

| Package | Version | Purpose | Docs |
| --- | --- | --- | --- |
| `react` | `^19.2.0` | UI runtime. | [react.dev](https://react.dev) |
| `react-dom` | `^19.2.0` | DOM renderer. | [react.dev](https://react.dev) |
| `react-router` | `^7.9.0` | Client-side routing across the five pages. | [reactrouter.com](https://reactrouter.com) |

### Development

| Package | Version | Purpose | Docs |
| --- | --- | --- | --- |
| `vite` | `^7.1.0` | Dev server (HMR) and production bundler. | [vite.dev](https://vite.dev) |
| `@vitejs/plugin-react` | `^5.0.0` | React Fast Refresh + JSX transform. | [github](https://github.com/vitejs/vite-plugin-react) |
| `typescript` | `^5.9.0` | Type checking (`deno task check:web`). | [typescriptlang.org](https://www.typescriptlang.org) |
| `@types/react` | `^19.2.0` | React type definitions. | |
| `@types/react-dom` | `^19.2.0` | React DOM type definitions. | |

**Six packages. No UI framework, no component library, no CSS framework, no state-management
library, no date library, no icon package.**

That is a deliberate position, and it holds up:

- **State** — `useReducer` + one context (`state.tsx`). The app's entire state is five SSE
  snapshots and a toast list. Redux/Zustand would be more code than the thing they manage.
- **Styling** — plain CSS with custom properties (`theme/tokens.css`). Two complete palettes
  switched by a `data-theme` attribute on `<html>`. Tailwind would add a build step and a
  dependency to produce what ~200 lines of CSS already does.
- **Components** — hand-written in `components/` (modal, drawer, kebab menu, tabs, size input,
  floating window), each implementing the correct WAI-ARIA pattern. A component library would
  have brought its own theme to fight, its own bundle weight, and its own accessibility bugs.
- **Icons** — inline SVG in `components/icons.tsx`.

The whole SPA is a handful of files. Keep it that way unless a dependency is genuinely load-bearing.

---

## Native Windows APIs

Called directly through Deno FFI. **No packages, no bindings, no wrappers.**

| DLL | Used for | Where |
| --- | --- | --- |
| `user32.dll` | `AllocConsole`/`ShowWindow` (the hidden console), `MessageBoxW` (fatal startup errors), the tray window class, menus, message pump | `main.ts`, `tray/tray_worker.ts` |
| `kernel32.dll` | `AllocConsole`, `GetConsoleWindow`, `GetModuleHandleW` | `main.ts`, `tray/tray_worker.ts` |
| `shell32.dll` | `Shell_NotifyIconW` (the tray icon), `SHBrowseForFolderW` (folder picker) | `tray/`, `system/` |
| `comdlg32.dll` | `GetOpenFileNameW` / `GetSaveFileNameW` (file pickers) | `system/dialog_worker.ts` |
| `ole32.dll` | COM init/teardown for the folder dialog | `system/dialog_worker.ts` |

This is what `--allow-ffi` in the compile flags is for.

Two things this buys, both of which a package would have obscured:

**A tray icon and native dialogs with zero dependency weight.** They are a few hundred lines of
struct layout and `Deno.dlopen`.

**Control over the console.** A `--no-terminal` (GUI-subsystem) exe spawning console children —
`wsl.exe`, `wslc.exe`, `reg.exe` — gives each child a **brand-new visible console window**. With
an 8-second poll, that is a console flashing on your screen forever. Deno 2.9 has no
`windowsHide` option on `Deno.Command`, so there is no library-level fix. The app allocates one
console at startup via FFI and hides it; every child inherits it. See
[the hidden console](../guides/deploying-to-production.md#the-hidden-console).

---

## Version compatibility

| Component | Minimum | Tested | Notes |
| --- | --- | --- | --- |
| Deno | 2.9 | **2.9.2** | Earlier versions may lack `--icon` on `deno compile`. |
| Windows | 10 build 19041 | 10 (19045), 11 | Some `.wslconfig` keys need Win11; gated in-app. |
| WSL | 2.x | 2.7.10, **2.9.3** | `wslc` requires a WSL release that ships it. |
| WebView2 | Evergreen | current | Optional (headless fallback). |
| Node.js | **not required** | — | Deno runs Vite and `tsc` directly. |

### Known constraints

**`@webview/webview` must stay pinned.** The version in `deno.json` and the DLLs in `dist/dll/`
are a matched pair. Bumping one without the other breaks offline launch, and the failure is at
runtime, not build time.

**Deno's only Windows target is `x86_64-pc-windows-msvc`.** No 32-bit, no ARM64 builds are
possible today.

**Deno 2.9 gotchas that shaped this codebase** (verify against your own version before assuming
they still hold):

- `Deno.Command` has **no `windowsHide` option** → the hidden-console workaround.
- `deno compile` does **not** auto-embed Workers → each needs an explicit `--include`.
- A Worker, or a bare pending promise, does **not** keep the event loop alive → headless mode
  runs the server on the main thread, and the webview-failure fallback holds a timer open.

---

## Updating

**Backend (JSR):**

```powershell
cd app
deno outdated              # see what's behind
deno outdated --update     # update deno.json + deno.lock
deno task check && deno task test
```

**Do not blind-bump `@webview/webview`.** Pull the matching DLLs from its release, replace
`dist/dll/`, and verify the window opens **with the network disabled**.

**Frontend (npm):**

Edit `frontend/package.json`, then:

```powershell
cd app
deno task build:web
deno task check:web
```

**After any update, run the whole gate:**

```powershell
deno task check && deno task test && deno task build:web && deno task check:web && deno task compile
```

And then actually launch the exe. The unit suite does not test the window, the tray, or the
dialogs — a dependency bump that breaks FFI or the WebView2 binding will pass every automated
check and fail at the first double-click. Work through the
[pre-release checklist](../guides/deploying-to-production.md#pre-release-checklist).

---

## Security scanning

`deno.lock` pins integrity hashes for every JSR module and is committed. Deno's permission model
is the primary containment: the compiled binary can only run four allowlisted binaries, read ten
named environment variables, and use FFI. A compromised transitive dependency cannot spawn
`powershell.exe` — the sandbox denies it, regardless of what the code asks for.

For the npm side, GitHub Dependabot alerts cover `frontend/package.json`. Given the surface — six
build-time packages and three runtime ones, none of which handle untrusted input from the network
— the realistic exposure is small, but the alerts are worth watching.

Report a vulnerability privately: [SECURITY.md](../../SECURITY.md).

---

## Related

- [Commands & scripts](commands-scripts.md) — what every task and compile flag does.
- [Building and releasing](../guides/deploying-to-production.md) — the DLL pairing rule.
- [Architectural overview](../concepts/architectural-overview.md) — why the shape is what it is.
