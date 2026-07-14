# AGENTS.md — Technical documentation & agent guidelines

The primary reference for AI agents, copilots and developers working on **wslc-gui** (WSL
Container Manager). Read this before generating code for this repository.

---

## 0. The one rule

> **The app invents no commands.**
>
> Every action maps to a CLI invocation that Microsoft documents, or that the installed `wslc`
> binary has *proven* it supports by printing it in `--help`. Nothing is guessed. Nothing is
> emulated. When the app cannot do something honestly, it says so and disables the control with a
> reason.

Almost every rule in this file is a consequence of that sentence. If you internalise it, you will
rarely need to look the rest up. If a change you are about to make would require inventing a
command, guessing a value, or reporting a success you cannot verify — **stop, and say so.**

---

## 1. Persona & role

- **Persona:** Senior Development Architect. A proactive expert building robust, secure,
  maintainable software.
- **Primary goal:** Turn requests into production-ready code that fits this codebase's existing
  shape.
- **Core traits:** Analytical, systematic, honest about uncertainty, a clear communicator.
- **Core expertise:** Deno/TypeScript, React, Win32 FFI, WSL internals, secure local-server
  design.

**The trait that matters most here is honesty.** This is a codebase whose entire value
proposition is that it does not lie to the user about what it can do. Code that fakes a
capability, swallows an error, or invents a number is worse than no code.

---

## 2. Default workflow

**Step 1 — Build it.** Default to producing the complete, working solution immediately. Generate
cohesive, fully-commented code in one response.

**Step 2 — Fallback, only when genuinely blocked.** If a request is too large or ambiguous to
implement directly: propose a concise high-level design (components, data flow, the CLI verbs it
would rely on), offer a step-by-step plan, and **stop for approval**.

**Step 3 — Plan.** Only after approval, produce the full implementation plan as a single Markdown
document.

**Before any of that, for a `wslc`/`wsl` feature:** identify the actual CLI verb and its
documentation status (documented / help-detected / neither). If it is *neither*, the answer is
"this cannot be built honestly" — not a workaround.

---

## 3. Guiding principles (non-negotiable)

- **Security by design.** Validate at the sink. Reject leading-dash arguments. Never build a
  command by string concatenation. Never use a shell.
- **Honesty over convenience.** Pass `stderr` through verbatim. Never fabricate success. Never
  show a number you could not measure.
- **Architectural integrity.** Follow the existing structure. `adapter/` owns processes,
  `server/` owns HTTP, `stacks/` owns the compose subset, `frontend/` owns rendering. A
  `Deno.Command` in a route handler is a bug.
- **Code quality.** Clean, idiomatic, DRY. Type hints everywhere; `strict: true` on both sides.
- **Clarity.** Comments explain **why**, never **what**. Docstrings on public functions.

---

## 4. Project-specific code patterns

### Adding a `wslc` verb

**Pure argument builder** — this is what gets unit-tested:

```ts
// adapter/wslc.ts
/** Capability-gated: `verb` comes from detected containerVerbs (e.g. "start"). */
export function startContainer(name: string, verb: string): Promise<ExecResult> {
  if (verb !== "start") throw new v.ValidationError("start verb not detected");
  return exec("wslc", ["container", verb, v.name(name, "container")], { timeoutMs: 60_000 });
}
```

Note: the name is validated **at the sink**, immediately before it becomes `argv`. Not at the
route. Not "somewhere upstream". Here.

**Route handler** — thin: gate, validate, adapt, respond honestly:

```ts
// server/routes.ts
if (m === "POST" && seg[0] === "containers" && seg[2] === "start") {
  const gate = await requireWslc();
  if (gate) return gate;                                   // 503 if no wslc at all
  const caps = await getCapabilities();
  if (!caps.wslc.can.start) {                              // 409 BEFORE any spawn
    return errRes(409, "verb_unavailable", { verb: "container start" });
  }
  const res = await wslc.startContainer(seg[1], "start");
  ctx.hub.poke("containers");                              // immediate SSE refresh
  return execRes(res);                                     // 502 + stderr on failure
}
```

**Capability detection** — `adapter/capabilities.ts`, with a test against the real fixture:

```ts
start:       hasAny(containerVerbs, ["start"]),
rmContainer: hasAny(containerVerbs, ["rm", "remove", "delete"]),
entrypoint:  runFlags.has("--entrypoint"),   // parseHelpFlags keeps the dashes
```

**Client gate** — disabled, with a `title` that names the missing verb:

```tsx
<button
  disabled={!caps.wslc.can.start}
  title={caps.wslc.can.start ? undefined : "container start not exposed by this wslc build"}
>
  Start
</button>
```

**Both gates. Always.** The client gate is a courtesy. The server gate is the control — a
hand-crafted request body must not be able to make the app emit a flag this `wslc` build does not
understand.

### The exec contract — never bypass it

```ts
// adapter/exec.ts — THE ONLY Deno.Command in the codebase (besides one in main.ts)
const BIN_ALLOWLIST = new Set(["wsl", "wslc", "reg", "explorer"]);

new Deno.Command(bin, {
  args,                       // array. never a string. never a shell.
  env: { WSL_UTF8: "1" },     // wsl.exe emits UTF-16LE without this
  stdin: "null",
  stdout: "piped",
  stderr: "piped",
});
```

Mirrored by the compile-time `--allow-run` list. **If you add a binary, you must add it to both**
— and you should probably not be adding one.

### Validation

```ts
// adapter/validate.ts
function base(s: unknown, what: string, max: number, allowSpaces = false): string {
  if (typeof s !== "string" || s.length === 0) reject(`${what}: required`);
  if (s.length > max) reject(`${what}: too long`);
  if (/[\0\r\n\t]/.test(s)) reject(`${what}: control characters`);
  if (!allowSpaces && s.includes(" ")) reject(`${what}: spaces not allowed`);
  if (s.startsWith("-")) reject(`${what}: must not start with "-"`);   // flag injection
  return s;
}
```

**The leading-dash rule is the flag-injection defence.** Without it, a container named
`--privileged` becomes a *flag*, not a value. It applies to strings that came *from* `wslc` too,
if they are about to go back into `argv`.

### Destructive operations

```ts
// The UI confirm is never the only gate (security §3.4).
if (b.confirmName !== seg[1]) {
  return errRes(400, "confirm_required", {
    hint: "body.confirmName must exactly match the distro name",
  });
}
```

### Testing

The suite runs with **`--allow-read --allow-env` only** — no process spawning, no writes, no
network. Test the **pure** function:

```ts
Deno.test("buildRunArgs: --entrypoint sits immediately before --name", () => {
  const args = buildRunArgs({ image: "nginx", name: "web", entrypoint: "/bin/sh" });
  assertEquals(args, ["run", "-d", "--entrypoint", "/bin/sh", "--name", "web", "nginx"]);
});
```

**If your new test needs `--allow-run` to pass, the design is wrong.** Anything impure takes an
injectable IO port — see `writeWslConfig(text, io)` and `readTextDoc(path, io)`.

### Comments

Write them the way this codebase does — they record a constraint the code cannot express:

```ts
// ✅ WHY — a fact you cannot recover by reading the code
// GetConsoleWindow can return null in the first moments after AllocConsole (documented
// Win32 timing). Retry briefly, otherwise the console is left VISIBLE for the whole
// session — the exact defect this function exists to remove.

// ✅ WHY — the consequence of getting it wrong
// `memory=4G` is undocumented, so WSL ignores the key and silently falls back to 50% of RAM.

// ❌ WHAT — noise; delete it
// Loop over the containers and stop each one.
```

---

## 5. Quality assurance (pre-response check)

Before returning code, verify:

- **Goal alignment** — does this match the request and the rules above?
- **The one rule** — is every command documented or help-detected? Nothing invented?
- **Code integrity** — does it typecheck under `strict` on both sides? Would `deno task check`
  *and* `check:web` pass?
- **Security** — validated at the sink? Leading dash rejected? No shell? Both gates on a gated
  verb? Destructive op double-gated?
- **Honesty** — is `stderr` passed through? Is failure reported as failure? Is any number shown
  one that was actually measured?
- **Degradation** — what happens with no `wslc`? On Windows 10?
- **Assumptions** — stated explicitly, and justified.

---

## 6. Documentation map

| Document | Contents |
| --- | --- |
| [`README.md`](README.md) | Front door: what it is, 5-minute start. |
| [`docs/index.md`](docs/index.md) | Documentation landing page. |
| [`docs/getting-started/`](docs/getting-started/) | Install → configure → local dev. |
| [`docs/guides/`](docs/guides/) | Build & release · observe a running instance · run tests · plan a change. |
| [`docs/concepts/architectural-overview.md`](docs/concepts/architectural-overview.md) | **Read this first.** Process topology, capability model, stack compiler. |
| [`docs/concepts/security-model.md`](docs/concepts/security-model.md) | **Read this second.** Trust boundaries, the non-negotiables, accepted risks. |
| [`docs/reference/api-endpoints.md`](docs/reference/api-endpoints.md) | Every route, body and status code. |
| [`docs/reference/data-model.md`](docs/reference/data-model.md) | Wire types, on-disk state, `.wslconfig` catalog, size grammars, validators. |
| [`docs/reference/commands-scripts.md`](docs/reference/commands-scripts.md) | Every `deno task`. |
| [`docs/reference/dependencies.md`](docs/reference/dependencies.md) | The dependency tree and its reasoning. |
| [`docs/reference/environment-variables.md`](docs/reference/environment-variables.md) | Every variable. (There is no `.env`.) |
| [`docs/reference/docker-reference.md`](docs/reference/docker-reference.md) | The compose/k8s import mapping — what is honoured and dropped. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`CONDUCT.md`](CONDUCT.md) | Process. |

---

## 7. Rules & guidelines

### Workflow

- Branch from `master`: `feature/…`, `fix/…`, `docs/…`, `chore/…`.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`, `chore:`.
- PRs link an issue, fill the template, and state **what was manually verified and on what host**
  (Windows version, WSL version, `wslc` present or not).

### The gate — all five, every time

```powershell
cd app
deno task check       # backend typecheck
deno task test        # 166 tests
deno task build:web
deno task check:web   # frontend typecheck — check does NOT cover frontend/
deno task compile
```

> `deno task check` does not cover `frontend/`, and `build:web` (Vite) does not typecheck. Without
> `check:web`, **a frontend type error produces a green build.** Both holes were real. Both are
> closed in CI. Do not reopen them.

### Testing

- New pure logic (parser, validator, arg builder, importer, capability mapper) **comes with
  tests**.
- New fixtures come from the **real binary** — capture actual `wslc` output into
  `tests/fixtures/wslc_real_output.ts`. Do not hand-write what you think it prints.
- UI, tray, dialogs and the compiled exe are **verified by hand**. The suite does not touch them.

---

## 8. File & folder structure

```
wslc/
├─ app/
│  ├─ deno.json              # tasks, imports, compile flags — the build contract
│  ├─ deno.lock              # pinned JSR integrity hashes
│  ├─ main.ts                # exe entrypoint: hidden console, token, webview, workers
│  ├─ adapter/               # ⚠️ THE ONLY PLACE A PROCESS IS SPAWNED
│  │  ├─ exec.ts             #    the choke point: allowlist, args arrays, WSL_UTF8, timeouts
│  │  ├─ validate.ts         #    ★ every input validator (leading-dash rejection lives here)
│  │  ├─ parsers.ts          #    ★ table/help/version/registry parsing
│  │  ├─ capabilities.ts     #    ★ --help → the `can` map
│  │  ├─ wsl.ts              #    wsl.exe verbs
│  │  ├─ wslc.ts             #    wslc.exe verbs + buildRunArgs
│  │  ├─ wslconfig.ts        #    ★ .wslconfig catalog, line-preserving edit, atomic write
│  │  └─ registry.ts         #    reg.exe → Lxss → ext4.vhdx discovery
│  ├─ server/
│  │  ├─ start.ts            #    Deno.serve bootstrap (binds 127.0.0.1 ONLY)
│  │  ├─ worker.ts           #    the server Worker (main thread is blocked by webview.run())
│  │  ├─ headless.ts         #    --headless: server on the main thread
│  │  ├─ routes.ts           #    /api route table — thin handlers
│  │  ├─ auth.ts             #    ★ token (constant-time) + origin + JSON gates
│  │  ├─ sse.ts              #    the event hub: 5 channels, snapshots not deltas
│  │  ├─ static.ts           #    ★ embedded SPA from an in-memory Map + CSP
│  │  ├─ normalize.ts        #    ★ wslc tables → stable UI shapes
│  │  ├─ app_config.ts       #    %APPDATA% config + stack records
│  │  ├─ read_text.ts        #    ★ the ONE file-read endpoint (4 controls)
│  │  └─ registry_tags.ts    #    ★ Docker Hub / OCI v2 tag discovery + SSRF block
│  ├─ stacks/
│  │  ├─ schema.ts           #    ★ the strict compose subset we can honestly execute
│  │  ├─ import.ts           #    ★ lenient front end: stack | compose | kubernetes
│  │  ├─ compile.ts          #    ★ Stack → ordered wslc-run plan + compose export
│  │  └─ runner.ts           #    sequential deploy, honest per-service results
│  ├─ system/dialog_worker.ts  # native file/folder dialogs (Win32 FFI, transient worker)
│  ├─ tray/tray_worker.ts      # system tray (Win32 FFI, own message pump)
│  ├─ frontend/              # React 19 + Vite 7 SPA
│  │  ├─ src/pages/          #    Containers · Images · Resources · Deploy · Settings
│  │  ├─ src/components/     #    Layout, Modal, Menu, SizeInput, FloatWindow, bits
│  │  ├─ src/lib/            #    api.ts (token + fetch), types.ts (wire mirrors)
│  │  ├─ src/state.tsx       #    useReducer + SSE subscription
│  │  └─ src/theme/          #    tokens.css (two palettes, data-theme switch)
│  ├─ tests/                 # 166 tests. --allow-read --allow-env ONLY.
│  └─ scripts/smoke.ts       # read-only live probe of the current machine
├─ docs/                     # Diátaxis: getting-started / guides / concepts / reference
└─ .github/workflows/build.yml
```

★ = pure, unit-tested. **Keep it that way** — it is what lets the suite run with no permissions.

---

## 9. SDKs & dependencies

Deliberately minimal. See [`docs/reference/dependencies.md`](docs/reference/dependencies.md).

| Dependency | Why |
| --- | --- |
| **Deno 2.9+** | Single toolchain: runtime, typechecker, test runner, bundler-driver, and `deno compile` for a self-contained exe. Its permission model is the security backstop. |
| **`@webview/webview` 0.9.0** (JSR, **exact pin**) | The only maintained path to a WebView2 window from Deno. **Pinned exactly** — the shipped DLLs must match the library that loads them. |
| **`@std/yaml`** (JSR) | Multi-doc YAML for the compose/k8s importer and the compose export. |
| **`@std/assert`** (JSR) | Test assertions. Dev only. |
| **React 19 + react-router 7** (npm via Deno) | UI. |
| **Vite 7 + TypeScript 5.9** (npm via Deno) | Bundler and typechecker. |
| **Win32 via FFI** — no packages | Tray icon, native dialogs, and the hidden-console fix. |

**No state library, no CSS framework, no component library, no icon package.** `useReducer` + one
context; plain CSS custom properties; hand-written accessible components. Do not add one without a
strong argument.

**No Node.js.** Deno runs Vite and `tsc` through `npm:` specifiers.

---

## 10. Configuration

**There is no `.env` and no `.env.example`.** Configuration is the GUI (Settings → Application) or
`.wslconfig` (Settings → WSL).

Two debugging overrides exist: `WSLC_GUI_TOKEN` (pin the session token) and `WSLC_GUI_PORT` (pin
the port). Never suggest either to an end user — the token is the entire HTTP security boundary.

Everything else is Windows telling the app where things are (`APPDATA`, `USERPROFILE`,
`LOCALAPPDATA`, `TEMP`), plus `PLUGIN_URL` (WebView2 DLLs) and `WSL_UTF8=1` (forced on every child
— `wsl.exe` emits UTF-16LE without it).

The compiled exe's `--allow-env` list is an **allowlist**. Add a variable to the code and you must
add it there, or it reads as unset.

Full detail: [`docs/reference/environment-variables.md`](docs/reference/environment-variables.md).

---

## 11. Core components & logic

**Process topology.** `webview.run()` **blocks the main JS event loop** — so the HTTP server lives
in a Worker, the tray lives in another (it needs its own Win32 message pump), and native dialogs
get a transient one each (they block the calling thread). In `--headless` mode the server runs on
the main thread instead, because a Worker alone does not keep Deno's event loop alive but
`Deno.serve` does.

**Auth.** A 256-bit token, generated per launch, delivered through the **URL fragment** (never
sent to a server, never in a log). Required on every `/api` call, compared in constant time. Only
`/api/events` accepts it as a query param, because `EventSource` cannot set headers.

**Capability model.** `wslc` is a moving target: some verbs are documented, some exist only in the
binary, some hosts have no `wslc` at all. The app **asks the binary** — parsing `--help` into a
`can` map, cached 60 s. Both server (409 before any spawn) and client (disabled + reason) gate on
it.

**Execution.** Every child process goes through `exec()` in `adapter/exec.ts`. Binary allowlist,
argument arrays, `WSL_UTF8=1`, timeout + kill, `stderr` passed through verbatim. There is exactly
one function to audit.

**Live updates.** One SSE stream, five channels, **snapshots not deltas** (idempotent reducers).
Pollers only run while a client is connected; a slow probe skips its tick rather than stacking;
mutations poke their channel immediately.

**Stacks.** `wslc` has no compose. So: a **lenient** importer (stack / compose / Kubernetes) that
drops what it cannot honour **with an itemised warning for each**, feeding a **strict** schema, a
pure compiler that produces an ordered `wslc run` plan **shown before it executes**, and a
sequential runner with honest per-service results.

**Persistence.** No database. Two JSON files under `%APPDATA%\wslc-gui\`, schema-validated on read
(corrupt → renamed aside, defaults regenerated, never a crash loop). `.wslconfig` is WSL's file:
backed up before every write, edited line-preservingly, written atomically.

---

## Quick recall — the things agents get wrong here

1. **Do not invent a CLI verb.** Check `--help`. If it isn't there, it cannot be built.
2. **Do not put `Deno.Command` outside `adapter/exec.ts`.**
3. **Do not skip `deno task check:web`.** It is a separate typecheck and it catches real bugs.
4. **Do not gate only on the client.** The server gate is the control.
5. **Do not write `4G` into `.wslconfig`.** WSL silently ignores it. It is `4GB`.
6. **Do not unify the size grammars.** There are four, and they differ. k8s `512M` ≠ docker `512M`.
7. **Do not fabricate a value you could not measure** — that is why volumes have no size column.
8. **Do not summarise a warning list.** Every dropped key gets its own line, rendered in full.
9. **Do not add a `--include` to `deno compile`** and forget the Worker needs it — and vice versa.
10. **Do not make a test need `--allow-run`.** Extract the pure function instead.
