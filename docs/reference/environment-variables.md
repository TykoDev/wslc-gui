# Environment variables

**There is no `.env` file in this project, and there is no `.env.example`.**

That is not an omission. A desktop app configured by environment variables would be a worse
desktop app — everything a user needs to set lives in the GUI (Settings → Application) or in
`.wslconfig` (Settings → WSL). See [Configuration](../getting-started/02-configuration.md).

The variables below exist for two reasons only: **debugging** (two of them), and **Windows
telling the app where things are** (the rest). You will not normally set any of them.

---

## Quick reference

| Variable | Required | Default | Set by | Purpose |
| --- | :---: | --- | --- | --- |
| `WSLC_GUI_TOKEN` | No | random 256-bit | **you** (debugging) | Override the session token. |
| `WSLC_GUI_PORT` | No | `0` (window) / `8747` (headless) | **you** (debugging) | Override the listen port. |
| `PLUGIN_URL` | No | *(unset)* | **the app**, or you | Where `@webview/webview` fetches its DLLs. |
| `WSL_UTF8` | — | `1` | **the app** | Forced on every child process. Never set this yourself. |
| `APPDATA` | Yes | *(Windows)* | Windows | `%APPDATA%\wslc-gui\` — config and stack records. |
| `USERPROFILE` | Yes | *(Windows)* | Windows | `%USERPROFILE%\.wslconfig`. |
| `LOCALAPPDATA` | Yes | *(Windows)* | Windows | Runtime working dir; `wslc` session-disk discovery. |
| `TEMP` / `TMP` | No | *(Windows)* | Windows | Default swap-file location. |
| `DENO_DIR` | No | *(Deno default)* | you | Deno module cache. Standard Deno variable. |

Every one of these is enumerated in the compiled binary's permission list:

```
--allow-env=WSL_UTF8,WSLC_GUI_TOKEN,WSLC_GUI_PORT,APPDATA,USERPROFILE,TEMP,TMP,LOCALAPPDATA,DENO_DIR,PLUGIN_URL
```

**If you add a variable to the code, add it here or it reads as unset in the compiled build.**
The list is an allowlist, not a suggestion.

---

## Debugging overrides

### `WSLC_GUI_TOKEN`

Pin the session token instead of generating a fresh 256-bit one.

```powershell
$env:WSLC_GUI_TOKEN = "dev"; deno task dev:server
# → http://127.0.0.1:8747/#t=dev
```

Useful when you want a URL you can keep pasting across restarts, or a `curl` invocation you can
keep in your shell history.

> **Never set this in anything a user runs.** The token is the only thing standing between a
> random web page and `DELETE /api/distros/Ubuntu`. In a normal launch it is 256 bits from
> `crypto.getRandomValues`, regenerated every time, and delivered through the URL fragment so it
> never reaches a server log. A predictable token throws all of that away.

### `WSLC_GUI_PORT`

Pin the listen port.

```powershell
$env:WSLC_GUI_PORT = "8750"; deno task dev:server
```

| Mode | Without it | Why |
| --- | --- | --- |
| **Window** | `0` — the OS picks an ephemeral port | Nothing needs to predict it; the exe navigates the webview itself. |
| **Headless** | `8747` | The Vite dev proxy has to point *somewhere* fixed. |

The usual reason to set it: a leftover `deno` process from a previous session is still holding
8747 and you want to sidestep it rather than hunt it down.

### `PLUGIN_URL`

Where `@webview/webview` looks for `webview.dll` and `WebView2Loader.dll`.

**The app normally sets this itself.** On startup, if a `dll\` folder sits next to the exe,
`main.ts` points `PLUGIN_URL` at it:

```
file:///C:/path/to/app/dll/
```

That makes launch fully offline. Without it, the library downloads both DLLs from the
webview_deno GitHub release on first run.

`main.ts` only sets it **if you have not already** — so an explicit value wins, which is what you
want when testing a different DLL build. Format: a `file://` or `https://` URL with a **trailing
slash**.

See [Building and releasing](../guides/deploying-to-production.md#the-release-layout).

---

## `WSL_UTF8` — set by the app, on every child

```ts
new Deno.Command(cmd, {
  args,
  env: { WSL_UTF8: "1" },   // always. no exceptions.
  ...
})
```

> **`wsl.exe` emits UTF-16LE unless `WSL_UTF8=1` is set in its environment.** Without it, every
> parser in the app receives mojibake.

This is not configurable and must not be. `adapter/exec.ts` sets it on **every** spawn, and the
decoder is *still* defensive about it — older builds ignore the variable for some subcommands, so
`decodeOutput()` sniffs for a UTF-16LE BOM (`FF FE`), for the `<byte> 00` interleave pattern, and
for orphaned NULs, and re-decodes accordingly.

Two layers, because one wasn't reliably enough.

---

## Windows-provided paths

The app reads these; Windows sets them. Nothing to configure.

| Variable | Used for |
| --- | --- |
| **`APPDATA`** | `%APPDATA%\wslc-gui\config.json` and `stacks.json`. **Throws if unset** — there is nowhere to put state. |
| **`USERPROFILE`** | `%USERPROFILE%\.wslconfig` and its backups. **Throws if unset.** |
| **`LOCALAPPDATA`** | `%LOCALAPPDATA%\wslc-gui\runtime\` (a guaranteed-writable working dir for the WebView2 loader and the tray icon), and `%LOCALAPPDATA%\wslc\sessions\` (WSL's own container-session disks, which the app reads to total your container storage). Degrades gracefully if unset. |
| **`TEMP`** / **`TMP`** | The default swap-file path, `%TEMP%\swap.vhdx` — used only when `.wslconfig` does not override `swapFile`. |
| **`DENO_DIR`** | Standard Deno module cache location. Only relevant when building. |

---

## What there deliberately isn't

**No frontend environment variables.** No `.env`, no `VITE_*`. The SPA's API base is always
same-origin `/api`, and its only runtime input is the session token from the URL fragment. There
is nothing to configure and therefore nothing to misconfigure.

**No database URL, no API keys, no secrets of any kind.** The app holds none. Registry tag
lookups are anonymous — public repositories only. Private registries are not supported, and the
app says so rather than asking for credentials it would then have to store.

**No production/staging split.** There is one artifact: an exe you double-click.

---

## Security notes

**The token is the whole security boundary at the HTTP layer.** Treat it accordingly:

- It is generated per launch and lives only as long as the process.
- It travels in a **URL fragment**, which is never sent to a server and never appears in a
  request log.
- **Do not commit a `WSLC_GUI_TOKEN` anywhere**, do not bake one into a script a user runs, and
  do not paste a real one into an issue.

`PLUGIN_URL` points at code that will be loaded into the process as a native DLL. **Only ever
point it at DLLs you obtained from the
[pinned webview_deno 0.9.0 release](https://github.com/webview/webview_deno/releases/tag/0.9.0)**
— it is a supply-chain surface, not a convenience setting.

There is nothing in this project that should ever be in a secret manager, because there is
nothing in this project that is a secret.

---

## Troubleshooting

**"APPDATA not set" / "USERPROFILE not set" on startup.**
You are running in a stripped environment. Both are mandatory — the app has nowhere to persist
state or find `.wslconfig` without them.

**Every API call 401s.**
No token reached the SPA. Open the app via the `#t=…` URL the server printed, not a bare
`http://127.0.0.1:5173/`.

**`Address already in use` on 8747.**
Set `WSLC_GUI_PORT`, or kill the leftover process: `Get-Process deno | Stop-Process`.

**Garbled `wsl.exe` output (`U�b�u�n�t�u`).**
UTF-16 leaking through. `WSL_UTF8` is not reaching the child — which should be impossible via
`exec()`. If you see this, you have a `Deno.Command` call somewhere outside `adapter/exec.ts`,
and that is a bug on two counts.

**The compiled exe behaves as if a variable is unset, but it works from source.**
It is not in the `--allow-env` list in `deno.json`. Deno's sandbox is denying the read silently.

### Verifying what the app sees

```powershell
deno run --allow-run --allow-read --allow-env --allow-sys=osRelease app\scripts\smoke.ts
```

The output shows the resolved `.wslconfig` path, the swap path, and the discovered storage
locations — i.e. exactly what the app derived from your environment. It is read-only.
