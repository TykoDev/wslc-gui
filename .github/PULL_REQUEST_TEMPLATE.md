<!--
Thanks for contributing! 🎉

Please fill this in. The manual-verification section matters more than usual here: the
automated suite does not test the compiled exe, the window, the tray, the dialogs, or any
real wsl/wslc call. Your description is the only evidence we have that those still work.
-->

## What & why

<!-- What does this change, and what problem does it solve? -->

Closes #

## Type

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (existing behaviour changes)
- [ ] Documentation
- [ ] Refactor / chore (no behaviour change)

---

## The gate

All five. CI runs exactly these and will fail the PR on any of them.

```powershell
cd app
deno task check       # backend typecheck
deno task test        # 166 tests
deno task build:web
deno task check:web   # frontend typecheck — `check` does NOT cover frontend/
deno task compile
```

- [ ] `deno task check` passes
- [ ] `deno task test` passes
- [ ] `deno task build:web` passes
- [ ] `deno task check:web` passes
- [ ] `deno task compile` passes

---

## Manual verification

<!-- REQUIRED for anything that isn't docs-only.

     The unit suite touches none of: the compiled exe, the WebView2 window, the system tray,
     the native dialogs, any React component, or a single real wsl.exe / wslc.exe invocation.
     So please say what you actually exercised and where.

     Good: "Win10 19045, WSL 2.9.3, wslc present — ran nginx from Quick run, confirmed the
            command preview matched the emitted argv, stopped it, deleted it. Also relaunched
            with wslc renamed away to confirm the unavailable hero still shows and Resources
            still works."

     "N/A — docs only" is a perfectly good answer when it's true. -->

**Host:** <!-- Windows version + build, WSL version, wslc present? -->

**What I exercised:**

---

## If you touched a `wslc` / `wsl` command

- [ ] The verb is **documented by Microsoft**, or **detected from `--help`** — not invented
- [ ] Detected in `adapter/capabilities.ts`, with a test against a **real** fixture
- [ ] **Server-side gate:** returns `409 verb_unavailable` *before* any process is spawned
- [ ] **Client-side gate:** the control renders disabled, with a `title` naming the missing verb
- [ ] The pure argument builder has a unit test

<!-- Both gates. The client one is a courtesy; the server one is the actual control. -->

## If you touched anything security-relevant

- [ ] Every child process still goes through `adapter/exec.ts` — no new `Deno.Command`
- [ ] No shell, anywhere. Argument arrays only. No string-built commands.
- [ ] New process arguments are **validated at the sink** in `adapter/validate.ts`
- [ ] Leading-dash arguments are still rejected (flag injection)
- [ ] Any new binary is in **both** the `exec.ts` allowlist **and** `--allow-run` in `deno.json`
- [ ] Any new destructive operation is **double-gated** (UI confirm *and* a server-side echo)
- [ ] `stderr` from any new command reaches the user, verbatim
- [ ] Any new environment variable is in the `--allow-env` list in `deno.json`

## Honesty check

<!-- The thing this project actually stands on. -->

- [ ] No fabricated success — a nonzero exit is reported as a failure with the real `stderr`
- [ ] No invented values — nothing is displayed that could not actually be measured
- [ ] Anything the app cannot honour is **dropped with a specific, itemised warning**, never silently

---

## Tests

- [ ] New pure logic (parser / validator / arg builder / importer) has unit tests
- [ ] New fixtures were **captured from the real binary**, not hand-written
- [ ] Existing tests still pass

## Docs

- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Relevant `docs/reference/*` updated (API routes, data model, commands, dependencies, env vars)
- [ ] Code comments explain **why**, not **what**

---

## Screenshots

<!-- For any UI change. Light *and* dark if you touched styling — the theme has two full palettes. -->

## Notes for the reviewer

<!-- Anything you're unsure about, a decision you'd like a second opinion on, or a known
     limitation you're deliberately shipping. Flagging it here is much better than having
     it found in review. -->
