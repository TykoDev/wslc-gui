---
name: Feature request
about: Suggest something the app should be able to do
title: ''
labels: enhancement
assignees: ''
---

<!--
One thing to know before you write this, because it will shape the whole conversation:

    THE APP INVENTS NO COMMANDS.

Every button maps to a CLI invocation that Microsoft documents, or that the installed
wslc binary proves it supports by printing it in `--help`. Nothing is guessed, nothing
is emulated.

So the first question on any feature is always: *which command would this run?*

If there isn't one, that is a completely fine thing to discover — open the issue anyway.
The honest answer may be "wait for WSL to ship it", and knowing that is genuinely useful.
Just don't be surprised when we ask.
-->

## The problem

<!-- What are you actually trying to do, and what makes it painful today?

     Describe the goal, not the solution. "I have to open a terminal every time I want to
     check which distro owns which vhdx" tells us more than "add a vhdx column". -->

## What you'd like

<!-- Your proposed solution. Which page would it live on? What would you click? -->

## Which command backs it?

<!-- The important one.

     Which `wsl.exe` or `wslc.exe` invocation would the app run? -->

- **Command:** <!-- e.g. `wslc volume export <name> <path>` -->
- **Is it in `--help` on your machine?** <!-- paste the relevant lines: -->

```

```

- **Is it documented by Microsoft?** <!-- link, or "not that I can find" -->
- **Don't know / there isn't one?** <!-- Say so. It's a legitimate answer and we'll work it out together. -->

## Degradation

<!-- Two things every feature here has to answer. Have a go — a guess is fine.

  * What should happen on a host with NO wslc at all?
    (Containers/Images/Deploy show an "unavailable" state; Resources/Settings must keep
    working completely.)

  * What should happen if the installed wslc build doesn't advertise the verb?
    (The usual answer: the control renders disabled, with a title naming the missing verb.)
-->

## Alternatives you've considered

<!-- Including "I just run the command by hand" — that's useful signal about how much
     friction this actually removes. -->

## Anything else

<!-- Mockups, links, prior art from Docker Desktop, related issues.

     If you're offering to implement it, say so! See CONTRIBUTING.md — and it's worth
     agreeing the approach in this issue before you write the code. -->
