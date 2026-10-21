# docs — what is where

Six folders and three files. Each folder answers one kind of question, and
this page exists so nobody has to guess which.

Reorganised 2026-09-04. Twenty-seven documents were loose at the top of `docs/`,
sorted by nothing, so finding the right one meant knowing its name already.

## Start here, by what you are doing

| Question | Go to |
|---|---|
| Setting up the server for the first time? | [`operations/FIRST-BOOT.md`](operations/FIRST-BOOT.md) — command by command |
| Deploying onto it for the first time? | [`operations/GOING-LIVE.md`](operations/GOING-LIVE.md) — code, secrets, TLS, and proving it |
| Are we ready to launch? | [`LAUNCH-CHECKLIST.md`](LAUNCH-CHECKLIST.md) — the tracked list |
| What changed, and why? | [`PROGRESS.md`](PROGRESS.md) — the running log, one entry per phase |
| Is this behaviour intended? | `../DESIGN.md` — the contract. On conflicts of fact, it wins |
| What is left to build? | `../PHASES.md` |

## The folders

| | Holds | Read first |
|---|---|---|
| [`policies/`](policies/) | Terms, Privacy, the age gate, jurisdictions, the staged payments patch | `terms-of-service.md` and `privacy-policy.md` |
| [`testing/`](testing/) | Coverage, results, findings, the launch gate, the load harness, the bug register | `README.md` |
| [`operations/`](operations/) | Running it: provisioning, runbooks, deployment, configuration, sign-in setup | `VPS-PROVISIONING.md` if the box does not exist yet, `OPERATIONS.md` once it does |
| [`product/`](product/) | The original briefs — advertising, monetization, cost, security, UI/UX — plus feature intake and the UI backlog | `../../DESIGN.md` §1.2 records where these conflict with the build, and how each was resolved |
| [`design/`](design/) | The prompts that generated the design and architecture documents | — |
| [`brand/`](brand/) | The mark as SVG, the palette as facts, and how to regenerate them | `README.md` |

## Where the shipped copy lives

`policies/` holds the **legal drafts**, with their reasoning and open questions.
Editing them does not change the site.

**The copy the site ships is `frontend/src/content/`**, and it is the source of
truth for itself. It used to transcribe a second set of files, with a test
binding the two; that source was a mock, and keeping it meant a throwaway folder
was the record of what the pages were allowed to say.

What replaced the binding is a set of checks in `pages.test.ts` that read the
content directly — no empty sections, no bracketed placeholder, retention
periods matching `config.ts`, no address that cannot receive mail, and no
sentence addressed to whoever is writing the page rather than to a reader. That
last one exists because the transcribed templates carried instructions to their
drafter, and the pages published them.

## The rule this folder is organised by

A document lives next to the documents that answer the same kind of question,
and nothing is duplicated between them. Where two files would say the same
thing, one says it and the other links.
