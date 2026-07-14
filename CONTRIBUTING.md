# Contributing to WSL Container Manager

**Thanks for being here.** This project exists because managing WSL containers through a pile of
`wsl.exe` and `wslc.exe` invocations is genuinely tedious, and because the honest alternative —
a GUI that tells you the truth about what it can and cannot do — didn't exist.

Contributions of every size are welcome: a typo fix, a parser that handles a `wsl.exe` output
format we haven't seen, a whole new page. You do not need to be a Deno expert or a Win32 expert.
You do need to be willing to check what a command actually does before you wire a button to it —
which is the one thing this codebase asks of everyone.

---

## The rule that shapes everything

> **The app invents no commands.**
>
> Every button maps to a CLI invocation that Microsoft documents, or that the installed `wslc`
> binary has *proven* it supports by printing it in `--help`. Nothing is guessed. When the app
> cannot do something honestly, it says so and disables the control with a reason.

If you understand that sentence, you already understand most of the review feedback you're likely
to get. A feature that requires the app to guess, estimate, or quietly hope is not a feature we
can ship — the honest answer to the user is a disabled control with an explanation.

---

## Ways to help

**Report a bug.** Especially parsing bugs. `wsl.exe` and `wslc.exe` output varies across versions,
languages and hosts, and we cannot test them all. If a distro name, container table or `--help`
block renders wrong, that is a real bug and the raw output is the fix.
→ [Open a bug report](https://github.com/TykoDev/wslc-gui/issues/new?template=bug_report.md)

**Suggest a feature.** Include the CLI verb it would use. If there isn't one, say so — sometimes
the answer is "wait for WSL to ship it", and knowing that is useful.
→ [Open a feature request](https://github.com/TykoDev/wslc-gui/issues/new?template=feature_request.md)

**Tell us what your `wslc` supports.** The capability model exists because `wslc`'s surface moves.
A paste of `wslc --help`, `wslc container --help`, `wslc image --help`, `wslc run --help` and
`wslc volume --help` from a version we haven't seen is directly useful — it becomes a test
fixture.

**Improve the docs.** If something in `docs/` sent you the wrong way, that's a bug too.

**Write code.** See below.

**Report a vulnerability.** **Privately, please** — see [SECURITY.md](SECURITY.md). Not a public
issue.

---

## Development setup

You need **[Deno 2.9+](https://deno.com/)** and **Git**. That is all — **no Node.js, no npm.**
Deno runs Vite and TypeScript itself.

```powershell
git clone https://github.com/TykoDev/wslc-gui.git
cd wslc-gui\app
```

There is no install step for the backend; Deno fetches and caches JSR modules on first run, pinned
by `deno.lock`.

**Run the tests** (~1 second, no permissions needed beyond read/env):

```powershell
deno task test
```

**Run the app** — two terminals:

```powershell
# Terminal 1 — API server on 8747. Prints a tokened URL.
deno task dev:server
```

```powershell
# Terminal 2 — SPA with hot reload on 5173, proxying /api → 8747
deno task dev:web
```

Then open `http://127.0.0.1:5173/#t=<the token terminal 1 printed>`.

**You need that `#t=` fragment.** Vite doesn't hand you a token — only the Deno server does. Without
it every API call 401s and the top bar shows `no session token`.

**Build the executable:**

```powershell
deno task build:web    # SPA → frontend/dist  (must come first!)
deno task compile      # → dist/wslc-gui.exe
```

There is **no `.env` file** to set up. Configuration lives in the GUI or in `.wslconfig`.

Full detail, including editor setup and troubleshooting:
**[docs/getting-started/03-local-development.md](docs/getting-started/03-local-development.md)**

---

## Before you open a PR

Run all five. **CI runs exactly these and will fail your PR on any of them.**

```powershell
cd app
deno task check       # backend typecheck
deno task test        # 166 tests
deno task build:web   # frontend bundle
deno task check:web   # frontend typecheck
deno task compile     # it must actually build
```

> **Both typechecks, every time.** `deno task check` does **not** cover `frontend/`, and
> `build:web` runs Vite, which does not typecheck at all. Without `check:web`, a frontend type
> error produces a perfectly green build. That hole was real. Please keep it closed.

---

## Coding standards

**TypeScript, `strict: true`, both sides.** No `any` without a comment explaining why.

**Follow the existing structure.** `adapter/` owns processes, `server/` owns HTTP, `stacks/` owns
the compose subset, `frontend/` owns rendering. A `Deno.Command` call in a route handler will be
sent back.

**Comments explain *why*, never *what*.** Read the existing code — the comments record constraints
you could not recover by reading the code:

```ts
// ✅ WHY
// GetConsoleWindow can return null in the first moments after AllocConsole (documented
// Win32 timing). Retry briefly, otherwise the console stays VISIBLE for the whole session.

// ❌ WHAT — delete this
// Loop over containers and stop each one.
```

**Formatting:** `deno fmt` for the backend. Match the surrounding style in `frontend/`.

---

## Security requirements

Non-negotiable. A PR that violates one of these will be sent back regardless of how good the
feature is. Full reasoning in the [security model](docs/concepts/security-model.md).

- **Every child process goes through `adapter/exec.ts`.** One choke point. The binary allowlist is
  `wsl`, `wslc`, `reg`, `explorer` — and it is mirrored by the compile-time `--allow-run` list.
  Adding a fifth binary is a design conversation, not a one-line diff.
- **Argument arrays only. Never a shell.** No `cmd /c`, no `powershell -c`, no string
  concatenation into a command.
- **Validate at the sink,** in `adapter/validate.ts`. In particular: **an argument starting with
  `-` is rejected** — that's the flag-injection defence, and it applies to values that came *from*
  `wslc` too, if they're going back into `argv`.
- **Destructive operations are double-gated.** A UI confirmation is never the only gate; the
  server requires its own echo (`confirmName`, `confirm: true`).
- **Never fabricate success.** A nonzero exit is a 502 with the real `stderr`.

---

## Adding a `wslc` verb

The most common contribution. The pattern:

1. **Confirm the verb exists.** Run `wslc <group> --help`. If it's not there, it cannot be built.
2. **Detect it** in `adapter/capabilities.ts`, with a test against a real fixture in
   `tests/fixtures/wslc_real_output.ts`.
3. **Gate it server-side** — the route returns **409 `verb_unavailable`** before any spawn.
4. **Gate it client-side** — the control renders disabled, with a `title` naming the exact verb it
   needs.
5. **Test the pure argument builder.**

Both gates. The client one is a courtesy to the user; the server one is the actual control.

---

## Testing

**New pure logic comes with tests.** Parsers, validators, argument builders, importers — all of
these are unit-testable, and all of them are tested.

**The suite runs with `--allow-read --allow-env` and nothing else.** It cannot spawn a process,
write a file, or reach the network. If your test needs `--allow-run` to pass, the design is
usually wrong — extract the pure function, or take an injectable IO port (see
`writeWslConfig(text, io)`).

**Fixtures come from the real binary.** Capture actual output. Do not hand-write what you think
`wslc` prints — that is how you get a test that passes against a fiction.

**The suite does not test the exe, the window, the tray, the dialogs, or any React component.**
Those are verified by hand. Say in your PR what you exercised, and on what host.

---

## Submitting

### Branches

Branch from `master`:

- `feature/volume-labels`
- `fix/distro-name-with-spaces`
- `docs/clarify-size-grammar`
- `chore/bump-vite`

### Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(volumes): expose volume labels in the inspect drawer
fix(parsers): handle distro names containing spaces
docs(reference): correct the .wslconfig size grammar
test(import): cover k8s millicore CPU limits
```

### Pull requests

1. Link the issue it closes (`Closes #12`).
2. Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md).
3. **Say what you verified by hand, and where.** "Tested on Windows 10 19045, WSL 2.9.3, `wslc`
   present: ran nginx, stopped it, deleted it" is worth more than a green checkmark, because the
   automated suite cannot tell us any of that.
4. Add a `CHANGELOG.md` entry under `[Unreleased]`.
5. Keep the diff as small as it can be while still doing the job.

### Docs

| If you changed… | Update |
| --- | --- |
| An API route | [`docs/reference/api-endpoints.md`](docs/reference/api-endpoints.md) |
| A wire type or on-disk shape | [`docs/reference/data-model.md`](docs/reference/data-model.md) |
| A `deno task` | [`docs/reference/commands-scripts.md`](docs/reference/commands-scripts.md) |
| A dependency | [`docs/reference/dependencies.md`](docs/reference/dependencies.md) |
| An environment variable | [`docs/reference/environment-variables.md`](docs/reference/environment-variables.md) |
| The compose/k8s mapping | [`docs/reference/docker-reference.md`](docs/reference/docker-reference.md) |
| Anything user-visible | [`CHANGELOG.md`](CHANGELOG.md) |

---

## Review

Expect questions about:

- **Which CLI verb backs this, and is it documented or help-detected?**
- What happens on a host with **no `wslc`**? On **Windows 10**?
- Is the new process argument **validated at the sink**?
- Does failure reach the user, with the real `stderr`?
- Is there a test for the pure part?

None of that is gatekeeping — it is the same checklist the existing code was held to, and it is
why the app can make the promises it makes.

Review may be slow; this is a small project. **A stalled PR is not a rejected one.** Ping it.

---

## Licence

By contributing, you agree that your contributions will be licensed under the
[GPL-3.0](LICENSE), the same licence as the project.

---

## Getting help

- **A question about the code** → open a [Discussion](https://github.com/TykoDev/wslc-gui/discussions) or a question issue.
- **A vulnerability** → **privately**, per [SECURITY.md](SECURITY.md). Never a public issue.
- **Not sure if an idea is in scope?** Open an issue and ask before you build it. Especially if the
  answer to "which CLI verb backs this?" is unclear — that is exactly the conversation worth having
  early.
