---
name: Bug report
about: Something doesn't work, or the app tells you something untrue
title: ''
labels: bug
assignees: ''
---

<!--
Before you start:

  * SECURITY VULNERABILITY? Do NOT open an issue. See SECURITY.md — report it privately.

  * "wslc unavailable" / a greyed-out button is often NOT a bug. The app deliberately
    disables anything the installed wslc build does not advertise in its --help. Paste
    the capability probe below and we'll tell you which it is.
-->

## What happened

<!-- One or two sentences. What did you see? -->

## What you expected

## Steps to reproduce

1.
2.
3.

## Environment

<!-- Please fill this in. Almost every bug in this project turns out to be
     version-specific, and without this we are guessing. -->

- **App version / commit:**  <!-- the release you downloaded, or `git rev-parse --short HEAD` -->
- **Windows version:**  <!-- run: [System.Environment]::OSVersion.Version -->
- **WSL version:**  <!-- run: wsl --version -->
- **`wslc` present?**  <!-- run: wslc version   → paste the output, or say "not found" -->
- **How are you running it?**  <!-- compiled .exe / --headless / from source (dev:server + vite) -->

## Capability probe

<!-- This is the single most useful thing you can give us, and it answers most
     "why is that button greyed out" questions outright.

     Easiest way: run the app with --headless, copy the token from the printed URL, then:

         $t = "<token>"
         curl.exe -H "Authorization: Bearer $t" http://127.0.0.1:8747/api/capabilities

     Paste the JSON here. There is nothing sensitive in it — but do NOT paste the token itself. -->

```json

```

## Raw CLI output

<!-- If this is a PARSING bug — a distro name rendered wrong, a container table with empty
     columns, a version pill showing nonsense — paste the RAW output of the command the app
     ran. This is what lets us turn your bug into a test fixture, and it is the fastest
     possible path to a fix.

     Depending on what looks wrong, one of:
         wsl --list --verbose
         wsl --status
         wslc container list --all
         wslc image list
         wslc stats
         wslc --help          (and: container --help / image --help / run --help / volume --help)
-->

```

```

## Error output

<!-- Any error toast, error dialog, or message box — copy the full text including the stderr
     detail (the app passes wslc/wsl stderr through verbatim, so it is usually the real answer).

     Running from a terminal? Paste the console output too. Note that the compiled exe hides
     its console by design — run it with --headless from a terminal to see stderr. -->

```

```

## Screenshots

<!-- Optional, but very helpful for anything visual. -->

## Anything else

<!-- Does it happen every time, or intermittently? Did it work before? Non-English Windows? -->
