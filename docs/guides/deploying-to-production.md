# How to build and release the executable

"Production" for this project means one thing: **a signed-off `wslc-gui.exe` that a user can
download and double-click.** There is no server to deploy, no container to push, no
infrastructure. This guide covers producing that binary — locally and through CI — and the
things that will bite you if you skip a step.

---

## The short version

```powershell
cd app
deno task check       # backend typecheck
deno task test        # 166 unit tests
deno task build:web   # SPA → frontend/dist
deno task check:web   # frontend typecheck
deno task compile     # → dist/wslc-gui.exe
```

Order matters. `compile` embeds `frontend/dist` into the binary — if you haven't run
`build:web`, you will ship an exe that serves a "Frontend bundle not found" page and you will
not find out until you launch it.

---

## What `deno task compile` actually does

The full command, from [`app/deno.json`](../../app/deno.json):

```
deno compile
  --no-terminal
  --icon assets/logo.ico
  --include assets/logo.ico
  --include server/worker.ts
  --include tray/tray_worker.ts
  --include system/dialog_worker.ts
  --include frontend/dist
  --allow-ffi
  --allow-net
  --allow-run=wsl,wslc,reg,explorer,C:\Program Files\WSL\wslc.exe
  --allow-read
  --allow-write
  --allow-env=WSL_UTF8,WSLC_GUI_TOKEN,WSLC_GUI_PORT,APPDATA,USERPROFILE,TEMP,TMP,LOCALAPPDATA,DENO_DIR,PLUGIN_URL
  --allow-sys=osRelease
  -o dist/wslc-gui.exe
  main.ts
```

Every flag is load-bearing:

**`--no-terminal`** builds a GUI-subsystem exe, so double-clicking doesn't open a console
window behind the app. This is also the source of the trickiest bug in the project's history —
see [the hidden console](#the-hidden-console) below.

**The four `--include` flags.** `deno compile` does **not** automatically embed Workers or
data directories. Each Worker (`server/worker.ts`, `tray/tray_worker.ts`,
`system/dialog_worker.ts`) and the SPA bundle must be named explicitly. Forget one and the exe
compiles fine and then fails at runtime when it tries to spawn that worker. There is no
compile-time error for this.

**`--allow-run` is the security backstop.** It lists exactly the four binaries the adapter's
own allowlist permits (`wsl`, `wslc`, `reg`, `explorer`) plus the absolute path `wslc` falls
back to. The Deno sandbox enforces this even if application code is wrong. If you add a binary
to `adapter/exec.ts`, you **must** add it here too — and think hard about whether you should.

**`--allow-env` is enumerated,** not blanket. Adding an environment variable to the code means
adding it here or it reads as unset in the compiled build.

**`--allow-read` / `--allow-write` are unscoped.** This is a deliberate, recorded compromise:
the paths the app touches (`%APPDATA%`, `%USERPROFILE%\.wslconfig`, arbitrary VHDX locations,
user-picked export targets) are not knowable at compile time, and pinning them risks breaking
across WSL updates. The mitigation is that every write site is centralised and reviewed. See
[the security model](../concepts/security-model.md#accepted-residual-risks).

**Target.** Deno's only Windows target is `x86_64-pc-windows-msvc`. There is no 32-bit and no
ARM option. The app is x64-only.

---

## The release layout

Ship the exe with a `dll/` folder beside it:

```
wslc-gui.exe
dll/
├─ webview.dll          # from webview_deno 0.9.0
└─ WebView2Loader.dll
```

**Why.** `@webview/webview` resolves those two DLLs **at module load**, from `PLUGIN_URL` or —
failing that — by downloading them from the webview_deno GitHub release. It also copies the
loader into the process's current working directory.

So `main.ts`, *before* it imports the webview library:

1. `chdir`s to `%LOCALAPPDATA%\wslc-gui\runtime` (a writable directory — the exe may sit
   somewhere read-only).
2. If a `dll\` folder exists next to the exe, points `PLUGIN_URL` at it and pre-places
   `WebView2Loader.dll` in the CWD, so the library skips its download-and-delete cycle
   entirely.

**With `dll/`: first launch is fully offline.** Without it: the first launch needs network
access once, and then works offline forever after. Both are supported — but a release without
the DLLs is a release that fails on an air-gapped machine.

Get them from the [webview_deno 0.9.0 release](https://github.com/webview/webview_deno/releases/tag/0.9.0).
The version is pinned in `deno.json` (`jsr:@webview/webview@0.9.0`); **the DLLs you ship must
match it.**

---

## CI

[`.github/workflows/build.yml`](../../.github/workflows/build.yml) runs on `windows-latest`
for every push to `master`/`main`, every pull request, every `v*` tag, and on manual dispatch.

```
checkout → setup-deno@v2 (v2.x)
  → deno task check       (backend typecheck)
  → deno task test        (166 unit tests)
  → deno task build:web   (SPA bundle)
  → deno task check:web   (frontend typecheck)
  → deno task compile     (the exe)
  → upload-artifact       (wslc-gui-windows-x86_64, if-no-files-found: error)
  → attach to release     (tags only)
```

**Both typechecks are in there on purpose.** `deno task check` does not cover `frontend/`, and
`build:web` runs Vite, which does not typecheck. Without `check:web` a frontend type error
produces a green build. That hole was real; it is closed.

The workflow needs `contents: write` — but only tag builds use it, to upload the release asset.

---

## Cutting a release

1. **Land everything on `master`** and confirm the build workflow is green.

2. **Update [`CHANGELOG.md`](../../CHANGELOG.md).** Move `[Unreleased]` items into a new
   version section with today's date. The format is
   [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
   [SemVer](https://semver.org/).

3. **Tag and push:**

   ```powershell
   git tag -a v1.0.0 -m "v1.0.0"
   git push origin v1.0.0
   ```

4. CI builds the exe and attaches it to a GitHub Release automatically
   (`softprops/action-gh-release@v2`).

5. **Attach the DLLs.** CI does not currently bundle `dll/`. Upload `webview.dll` and
   `WebView2Loader.dll` to the release manually, or the download is not offline-capable.
   (Automating this is a good first contribution.)

6. **Smoke-test the artifact on a clean machine.** Not the one you built on — see the
   pre-release checklist below.

---

## Pre-release checklist

The unit tests do not cover the compiled binary, the WebView2 window, the tray, or the native
dialogs. Those need a human. On a machine that is **not** your dev box:

- [ ] Double-click the exe. A window opens. **No console window flashes** — not at launch, not
      while it polls.
- [ ] The tray icon appears. Right-click → all four items. Minimize → hides to tray.
      Double-click tray → restores.
- [ ] Top bar shows the correct WSL version and either a `wslc` version or `wslc unavailable`.
- [ ] **Resources works without `wslc`.** This is the load-bearing degradation promise.
- [ ] With `wslc`: run a container from Deploy, see it on Containers with live CPU/memory,
      stop it, delete it.
- [ ] Settings → WSL: the `.wslconfig` editor loads, a save creates a `.bak.<ts>` file, and on
      Windows 10 the Win11-only keys are disabled with a reason.
- [ ] A native file picker (Deploy → From file) opens **in front of** the app window and is
      modal to it.
- [ ] Delete the `dll/` folder, disconnect the network, launch. It should fail *gracefully* —
      a message box, then the browser fallback. Restore `dll/`, relaunch offline: the window
      should open with no network at all.

---

## The hidden console

Worth knowing before you touch `main.ts`.

A `--no-terminal` (GUI-subsystem) process has no console. When such a process spawns a
**console** child — and `wsl.exe`, `wslc.exe` and `reg.exe` all are — Windows gives each child
a **brand-new visible console window.** With an 8-second polling loop, that means a console
window flashing on your screen every few seconds, forever.

Deno 2.9 has no `windowsHide` option on `Deno.Command`, so there is no clean fix. What `main.ts`
does instead, at the very top of startup:

1. `AllocConsole()` — allocate exactly one console for the process.
2. `GetConsoleWindow()` → `ShowWindow(hwnd, SW_HIDE)` — hide it.

Every child then **inherits** that hidden console and no new windows appear.

Consequences you inherit along with it:

- **`console.error` goes nowhere the user can see.** That is why fatal startup errors use
  `MessageBoxW` — it is the only channel that reaches a user of the compiled app.
- If a console already exists (you launched from a terminal), `AllocConsole` fails and the code
  deliberately does nothing.
- `GetConsoleWindow()` can return null for a moment after `AllocConsole` — a documented Win32
  race. The code retries for ~100 ms. Without that retry, the console is left **visible for the
  whole session**, which is precisely the defect it exists to remove.

Do not "simplify" this function.

---

## Related

- [Architectural overview](../concepts/architectural-overview.md) — the process topology this build produces.
- [Commands & scripts reference](../reference/commands-scripts.md) — every task, exhaustively.
- [Dependencies](../reference/dependencies.md) — what gets compiled in, and why.
