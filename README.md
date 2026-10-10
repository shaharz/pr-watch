# pr-watch

A Claude Code mod that watches your pull requests in a small panel above the prompt, anchored right: CI status, new review comments (Codex included) and Codex's review status, with one-click or automatic hand-off of failures and comments to Claude.

## Install

```
/plugin install pr-watch --marketplace shaharz/pr-watch
```

Needs the GitHub CLI (`gh`) logged in. Built against Claude Code 2.1.295; the function-hooks API is early access.

## What it shows

Two lines per watched PR: the title (click it to open the PR), then ❌ failing checks by name, ⏳ running checks or ✅ when all pass; 💬 new comments since you last dismissed them, with their authors; 🔍 while Codex reviews and 👍 when it finished with nothing to say. Errors from `gh` (auth, rate limits) show on the row.

Codex's findings arrive as inline review comments, which count as comments; its summary comment only drives the 🔍/👍 status. Reviews with no text (bare approvals) are not comments.

PRs join the panel when a session runs `gh pr create` or pushes a branch that has a PR, when Claude calls the `watch_pr` tool, or with `/pr-watch add <url|number>`. The list is per session. It polls every 60 seconds and sends a notification when checks finish or new comments arrive.

## Hand-off

Row buttons: `🔧 fix` (beside the failing checks) hands them to Claude, `📨 assess` (beside the new comments) hands those over, `dismiss` marks the new comments read without handing them over, `auto off`/`auto on` toggles automatic hand-off (each failing set of checks once per commit, each comment once), `×` stops watching.

Default instructions:

- Failing checks: investigate and fix on the PR's branch and commit; say so if it isn't caused by the PR; don't push without asking.
- Comments: read and assess each one; don't change code, push or reply on GitHub until told which to act on.

Change them with `/pr-watch prompt ci <text>` or `/pr-watch prompt comments <text>` (`default` restores).

## Commands

`/pr-watch` (status), `/pr-watch add <url|number>`, `/pr-watch rm <number>`, `/pr-watch auto <number|all> on|off`, `/pr-watch prompt ci|comments [text|default]`, `/pr-watch width <columns|full>` (default 80; the band can't be dragged), `/pr-watch refresh`.

Comments from `github-actions` and `linear-code` are ignored, as are your own.
