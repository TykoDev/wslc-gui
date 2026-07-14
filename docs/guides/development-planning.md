# How to plan and land a change

This project has one organising principle, and most decisions fall out of it:

> **The app invents no commands.** Every action maps to a CLI invocation that is either
> documented by Microsoft, or proven to exist by parsing `--help` on the user's own machine.
> When the app cannot do something honestly, it says so.

Almost every rule below is a consequence of that sentence. If you internalise it, you will
rarely need to look the rules up.

---

## Evaluating a feature request

Before writing a line, answer these in order. A "no" at any step usually ends it.

### 1. Does a real CLI verb back it?

Find the actual command. `wslc --help`, `wsl --help`, or Microsoft's documentation.

- **Documented and always present** (e.g. `wslc container stop`) → build it plainly.
- **The binary advertises it, but the docs don't** (e.g. `container start`, `image rm`, the
  `volume` verbs, `run --entrypoint`) → build it **capability-gated**. See below.
- **Neither** → **do not build it.** Not with a shell-out, not with a "clever" workaround, not
  with a plausible guess. The honest answer to the user is a disabled control with a reason.

There is precedent for getting this wrong in *both* directions. An earlier revision warned that
"wslc documents no volume-create verb" — that was simply false, `wslc` ships a full volume
lifecycle, and the warning was deleted rather than softened. Check the binary. Do not trust a
previous assumption, including one in this repo.

### 2. Can the app tell the truth about the result?

Every command's `stderr` is passed through to the user verbatim. If a feature would require
inventing a number, guessing a state, or reporting success you cannot verify — it is the wrong
feature.

Real example: `GET /api/volumes` has **no size field**. `wslc volume inspect` reports neither a
size nor a mountpoint, so a per-volume byte count cannot be obtained. It is therefore not shown
— rather than estimated, and rather than displayed as `—` with an ambiguous meaning. The UI
explains instead that those bytes are already counted in the "Container storage" tile.

### 3. Does it degrade honestly on a host that lacks it?

Two axes matter:

- **No `wslc` at all.** Containers/Images/Deploy show an explicit unavailable state.
  **Resources and Settings must keep working completely.** This is a promise the hero screen
  makes in writing; do not break it.
- **Windows 10.** Several `.wslconfig` keys are Windows 11 only. They are shown but disabled,
  with the reason stated. Not hidden — the user should be able to see what they're missing.

### 4. Is it a documented user need, or a Docker Desktop habit?

`wslc` is not Docker. It has no compose support, no build, no swarm. Do not port a Docker
Desktop feature just because users expect the shape of it. The Deploy page exists precisely
*because* `wslc` has no compose — the app sequences documented `wslc run` calls itself and is
explicit that this is what it's doing.

---

## Capability gating

The pattern for any verb the binary has but the docs don't:

**1. Detect it.** `adapter/capabilities.ts` parses `wslc --help`, `container --help`,
`image --help`, `run --help` and `volume --help` and turns them into a `can` map. Add your verb
there, with a test against the real fixture in `tests/fixtures/wslc_real_output.ts`.

**2. Gate it server-side.** The route checks `caps.wslc.can.<verb>` and returns
**409 `verb_unavailable`** before any process is spawned.

**3. Gate it client-side too** — the control renders disabled with a `title` naming the exact
verb it needs (e.g. `"container rm not exposed by this wslc build"`).

**Both gates. Always.** The client is not trusted: a hand-crafted request body must not be able
to make the server emit a flag that this `wslc` build does not understand. Client-side gating is
for the user's benefit; server-side gating is the actual control.

---

## Security requirements

Non-negotiable. A PR that violates one of these will be rejected regardless of how nice the
feature is. The full reasoning is in the [security model](../concepts/security-model.md).

**Every child process goes through `adapter/exec.ts`.** One choke point. Binary allowlist:
`wsl`, `wslc`, `reg`, `explorer`. If your feature needs a fifth binary, that is a design
conversation, not a one-line diff — and it needs the compile-time `--allow-run` list updated to
match.

**Argument arrays only. Never a shell.** No `cmd /c`, no `powershell -c`, no string
concatenation into a command. Ever.

**Every user-influenced argument is validated in `adapter/validate.ts`,** at the sink. In
particular: **an argument that starts with `-` is rejected.** That is the flag-injection
defence, and it applies to values that came *from* `wslc` too if they are about to go back into
`argv`.

**Destructive operations are double-gated.** A UI confirmation is never the only gate. The
server requires its own echo in the request body:

| Operation | Server-side requirement |
| --- | --- |
| `DELETE /api/distros/:name` | `{"confirmName": "<exact distro name>"}` |
| `POST /api/wsl/shutdown` | `{"confirm": true}` |
| `POST /api/volumes/prune` | `{"confirm": true}` |

**Never fabricate success.** A nonzero exit is a 502 with the real `stderr`. Not a retry, not a
"probably fine", not a swallowed error.

---

## Code standards

- **TypeScript, `strict: true`,** on both sides. Both typechecks must pass:
  `deno task check` (backend) **and** `deno task check:web` (frontend). The first does not cover
  the second — this hole was real and shipped a green build with a frontend type error in it.
- **Comments explain *why*, never *what*.** Read the existing code: comments say things like
  "`GetConsoleWindow` can return null in the first moments after `AllocConsole` (documented
  Win32 timing)" and "WSL ignores undocumented sizes and silently falls back to its default".
  They record a constraint the code cannot express on its own. A comment that narrates the next
  line is noise; delete it.
- **Pure core, thin shell.** Anything spawn-free and IO-free lives in a pure exported function
  that the tests can drive. This is what lets the test suite run with only `--allow-read` and
  `--allow-env`.
- **Follow the existing structure.** `adapter/` owns processes, `server/` owns HTTP,
  `stacks/` owns the compose subset, `frontend/` owns rendering. Do not put a `Deno.Command`
  call in a route handler.

---

## Testing expectations

Before you open a PR:

```powershell
deno task check       # backend typecheck
deno task test        # 166 tests
deno task build:web
deno task check:web   # frontend typecheck
deno task compile     # it must actually build
```

**A new pure function comes with tests.** Parsers, validators, argument builders, importers,
the capability mapper — all of these are unit-testable and all of them are tested. If your
change adds one and no test, expect that to come up in review.

**A new fixture comes from the real binary.** Capture actual `wslc` output; do not hand-write
what you think it prints.

**UI, tray, dialogs and the compiled exe are verified by hand** — the suite does not touch them.
Say in your PR what you exercised and on what host (Windows 10 or 11, WSL version, `wslc`
present or not). "Tested on Win10 19045, WSL 2.9.3, wslc present: ran a container, stopped it,
deleted it" is worth more than a green checkmark.

---

## Documentation requirements

A change is not done when the code works.

| If you changed… | Update |
| --- | --- |
| An API route | [`docs/reference/api-endpoints.md`](../reference/api-endpoints.md) |
| A wire type or on-disk shape | [`docs/reference/data-model.md`](../reference/data-model.md) |
| A `deno task` | [`docs/reference/commands-scripts.md`](../reference/commands-scripts.md) |
| A dependency | [`docs/reference/dependencies.md`](../reference/dependencies.md) |
| An environment variable | [`docs/reference/environment-variables.md`](../reference/environment-variables.md) |
| The compose/k8s import mapping | [`docs/reference/docker-reference.md`](../reference/docker-reference.md) |
| Anything user-visible | [`CHANGELOG.md`](../../CHANGELOG.md), under `[Unreleased]` |

---

## Definition of ready

A change is ready to start when:

- [ ] The backing CLI verb is identified, and its documentation status (documented /
      help-detected / neither) is known.
- [ ] The degradation path is decided — what happens with no `wslc`, and on Windows 10.
- [ ] Any new process argument has a validator, or a reason it needs none.
- [ ] Any destructive step has both gates designed.

## Definition of done

- [ ] `check`, `test`, `build:web`, `check:web`, `compile` all pass locally.
- [ ] New pure logic has unit tests; new fixtures came from the real binary.
- [ ] Both capability gates are in place, if applicable.
- [ ] `stderr` from any new command reaches the user.
- [ ] Docs updated per the table above; `CHANGELOG.md` has an `[Unreleased]` entry.
- [ ] Manually exercised on a real host — and the PR says which one.
- [ ] The diff is the smallest one that does the job.

---

## Accessibility

Not optional, and mostly already solved — copy the existing patterns rather than inventing new
ones.

- The kebab menu (`components/Menu.tsx`) has full keyboard support: `ArrowDown` opens; arrows,
  `Home` and `End` navigate; `Escape`/`Tab` close and return focus to the trigger.
- Modals trap focus, restore it on close, and default-focus **Cancel** on destructive confirms.
- Toasts live in an `aria-live="polite"` region; errors get `role="alert"`, and the detail is
  mirrored into an `sr-only` span — a collapsed `<details>` is never announced.
- Tabs implement the WAI-ARIA pattern with roving `tabindex` and real `aria-controls`.
- The theme tokens are AA contrast-checked in both light and dark.

Every disabled control carries a `title` explaining *why*. A greyed-out button with no
explanation is a bug in this codebase.

---

## Performance

There is not much to tune, but there are traps.

- **Do not add a poller without an in-flight guard.** `server/sse.ts` skips a tick if the
  previous one is still running. Without that, a slow `wslc` call on a loaded host stacks child
  processes without bound.
- **Do not poll when nobody is watching.** Every push method returns early when
  `clients.size === 0`.
- **Two `wslc` calls, not N+1.** `listVolumes()` does one `volume list` and then *one*
  `volume inspect` with every name — `wslc volume inspect` accepts multiple names in a single
  call. Check for this kind of affordance before writing a loop.
- **Respect the ceilings.** 64 SSE clients, 1 MB request bodies, 256 KB file reads, 2 MB
  registry responses. They exist because an unbounded read is an unbounded read even on
  loopback.

---

## Related

- [Security model](../concepts/security-model.md) — the reasoning behind the non-negotiables.
- [Architectural overview](../concepts/architectural-overview.md) — where your code belongs.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — branches, commits, PR process.
