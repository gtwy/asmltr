# Ivy

`ivy` is the Grok/Ivy fork of asmltr. It lives here and on
`git@github.com-asmltr:gtwy/asmltr.git`. Never push it to `jarethmt/asmltr`.

Upstream is `jarethmt/asmltr` `main`, fetched read-only as `upstream`. The
GitHub fork's default `main` is stale. Ignore it. Do not change the default
branch.

## What this branch adds

None of this is on `jarethmt/asmltr` `main`. Keep it on conflict.

- **Grok CLI engine.** Subscription only. `--effort high`. Auto-xhigh on
  code-ish turns and a project git cwd. Do not set `XAI_API_KEY`.
- **Finite idle.** Default 30 minutes (`ASMLTR_IDLE_MS=1800000`). After that
  the grok resume UUID is dropped and a new session starts.
- **Self silo.** Per-turn write. Last-topics inject on a fresh session.
- **Ivy stream.** SSE leftover flush. Dashboard `/v2/` is no-buffer, no-gzip.
- **User systemd units.** `asmltr-core`, `asmltr-collector`, `asmltr-manager`
  under `~/.config/systemd/user/`. Templates in `scripts/`.
- **Grok text-as-delta.** No trim mash. Live text is stored text.
- **SessionDetail autoscroll.** Inner transcript pane of the FloatingWindow.
  Not `document.body`. Not ModalShell.
- **Engines login command.** Own line: `grok login --device-auth`.

## Live on osiris, not in git

These stay on the host. They are gitignored or were never in the tree. Do
not commit them. Do not paste their values.

- `.env`
- `vault.pass`
- `ASMLTR_AUTH_SECRET`
- insights token
- `docker-compose.local.yml`
- host nginx (James's, not the repo)

Dashboard binds `127.0.0.1:8091`. Public front is James's nginx +
`ivy.gtwy.net`. Do not read `/etc/nginx`.

`env.ivy.example` is the localhost template. Copy it to `.env` on a new box
and fill secrets there, not here.

## Taking upstream

Fetch `jarethmt` `main` from the read-only remote. Merge into `ivy`. Merge
commit, not reset, not GitHub Sync fork.

```
git fetch upstream main
git checkout ivy
git merge --no-ff upstream/main
```

On conflicts: keep ivy stream / Grok / idle. Take their display and docs
unless they overwrite a Grok path.

Never push to `jarethmt`. `upstream` push is disabled on purpose.

Push only:

```
git push origin ivy
```

`origin` is `git@github.com-asmltr:gtwy/asmltr.git`.

## Are we current?

`ivy` should be 0 behind `upstream/main` and N ahead.

```
git fetch upstream
git rev-list --left-right --count upstream/main...ivy
```

First number is behind. Second is ahead. `0 N` is current.

Do not use the fork's `main` to judge that. It is stale. Leave the GitHub
default branch alone.
