# claude-prompt-upgrade

A plugin for [Claude Code](https://docs.claude.com/en/docs/claude-code): **prompt-upgrade**.

Asks you a few quick questions, then rewrites your short prompt into a much more detailed one,
copies it to the clipboard and opens a new Claude Code session beside this one to paste it into.
You choose who does the rewriting: Claude or Codex.

Part of [claude-mods](https://github.com/MohamedHamed001/claude-mods), which lists this plugin and its siblings.

## Install

```
/plugin marketplace add MohamedHamed001/claude-prompt-upgrade
/plugin install prompt-upgrade@claude-prompt-upgrade
```

Then start a new session: a session reads its plugins once, when it starts. Update later with
`/plugin marketplace update claude-prompt-upgrade`.

## Requirements

- **Claude Code 2.1.28x or newer.** The plugin uses function hooks (TypeScript modules the app
  loads), which older versions do not run.
- **For the Codex option:** the [Codex CLI](https://github.com/openai/codex) on your `PATH`, logged
  in. Without it, Claude still works and Codex reports that it could not run.

## What it does

| To | Do |
|---|---|
| Upgrade a prompt with Claude | `/upgrade fix the login bug` (or `/upgrade -claude fix the login bug`) |
| Upgrade a prompt with Codex | `/upgrade -codex fix the login bug` |
| Upgrade what you already typed | `/upgrade -claude` or `/upgrade -codex` with no prompt |

Then:

1. The chosen model reads your prompt and writes 2 or 3 multiple-choice questions about it (the
   goal, the scope, constraints, the output). You answer them in the usual question dialog, or
   type your own answer. The status line under the prompt says which step it is on.
2. The same model rewrites your prompt with your answers.
3. The rewritten prompt is copied to the clipboard and shown as the command's output.
4. A new `claude` session opens in a split pane beside this one, in the same folder. Paste the
   prompt there (Ctrl+V), change it if you like, and send it.

The new session starts empty rather than with the prompt already sent, so you can read and edit
it first.

### Where the side session opens

| Terminal | How |
|---|---|
| tmux (also tmux inside Windows Terminal) | `tmux split-window -h` |
| Windows Terminal | `wt -w 0 split-pane -V` |
| Anything else (macOS Terminal, iTerm2, the desktop app, VS Code) | No pane opens; the prompt is still on the clipboard, so paste it into a new session yourself |

If the clipboard is not available (a remote session), no pane opens either: the command's output
shows the prompt to copy by hand.

## How Codex is called

`codex exec --skip-git-repo-check --sandbox read-only -`, with the prompt on standard input. The
read-only sandbox means Codex cannot change your files while it writes the questions and the
rewrite; its answer is read from standard output. Each call may take up to three minutes.

Claude is called with a single completion on the session's own client (the `sonnet` model), with
none of the conversation's history.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/upgrade.ts` holds the pure logic (reading the `-codex` flag, the two prompts, reading the
questions back, the split-pane command for each terminal) and `hooks/register.tsx` the command
and the flow. Calls on `$` stay in `register.tsx`: the engine follows `$` only into functions
declared in the hooks module itself.

## Licence

MIT, see [LICENSE](LICENSE).
