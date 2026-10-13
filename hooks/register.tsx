// Prompt Upgrade: `/upgrade [-claude|-codex] [prompt]` turns a short prompt
// into a detailed one. The flow is:
//   1. pick the prompt (the argument, or the draft in the prompt box)
//   2. the chosen provider writes 2-3 questions; we ask them with `$.ui.ask`
//   3. the same provider rewrites the prompt using the answers
//   4. the result goes on the clipboard, and a new `claude` session opens in a
//      split pane beside this one, ready for you to paste it

import type { EngineInterface, Register } from 'claude-code'

import type { Provider } from '../types'
import type { Answer } from './upgrade'
import { cleanReply, parseArgs, parseQuestions, questionsPrompt, rewritePrompt, sidePaneCommand } from './upgrade'

const NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' }

// ---- Providers: the one place that knows how to reach Claude or Codex. ----
// Everything else calls `complete($, provider, prompt)` and gets the same shape
// back. It lives in this file, not its own, because the engine only follows `$`
// into functions declared in the hooks module itself, never across an import.

type Completion = { isOk: true; text: string } | { isOk: false; reason: string }

const CLAUDE_MODEL = 'sonnet'
const CODEX_TIMEOUT_MS = 3 * 60 * 1000

async function complete(
  $: EngineInterface,
  provider: Provider,
  prompt: string,
): Promise<Completion> {
  return provider === 'codex' ? completeWithCodex($, prompt) : completeWithClaude($, prompt)
}

// Claude: a single completion on the session's own client, with no history.
// `$.model.complete` never throws over what the API did; it tells us in
// `isAnswered` and `reason`.
async function completeWithClaude($: EngineInterface, prompt: string): Promise<Completion> {
  const result = await $.model.complete({ model: CLAUDE_MODEL, prompt, maxTokens: 4000 })
  if (!result.isAnswered) {
    return { isOk: false, reason: `Claude did not answer (${result.reason})` }
  }

  return { isOk: true, text: result.text }
}

// Codex: run the Codex CLI non-interactively. `codex exec -` reads the prompt
// from standard input; `--sandbox read-only` makes sure it cannot edit files
// while it only writes text for us. Its final answer comes out on stdout.
async function completeWithCodex($: EngineInterface, prompt: string): Promise<Completion> {
  const argv = ['codex', 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-']

  let result
  try {
    result = await $.process.run(argv, { stdin: prompt, timeoutMs: CODEX_TIMEOUT_MS })
  } catch (error) {
    // The call rejects when `codex` is not installed or runs past the timeout.
    const message = error instanceof Error ? error.message : String(error)
    return { isOk: false, reason: `Could not run Codex: ${message}. Is the codex CLI installed and logged in?` }
  }

  if (result.exitCode !== 0) {
    const lastLines = result.stderr.trim().split('\n').slice(-3).join(' ')
    return { isOk: false, reason: `Codex exited with ${result.exitCode}: ${lastLines}` }
  }
  if (result.stdout.trim() === '') {
    return { isOk: false, reason: 'Codex answered with nothing' }
  }

  return { isOk: true, text: result.stdout }
}

// ---- The side session ----

// Opens `claude` in a split pane beside this terminal, in the same folder.
// Which command does that depends on the terminal, which we tell apart by the
// variables each one sets for the programs inside it. Returns a line saying
// what happened; never throws.
async function openSidePane($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const argv = sidePaneCommand(
    { isWindowsTerminal: (await $.env.get('WT_SESSION')) !== undefined, isTmux: (await $.env.get('TMUX')) !== undefined },
    cwd,
  )
  if (argv === null) {
    return 'Open a new Claude Code session and paste it (no Windows Terminal or tmux to split).'
  }

  try {
    // Both commands return as soon as the pane exists; the session in it
    // runs on its own, so a short timeout is enough.
    const result = await $.process.run(argv, { timeoutMs: 15000 })
    if (result.exitCode !== 0) {
      return `Could not open a side session (${argv[0]} exited with ${result.exitCode}); paste it in a new session.`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Could not open a side session (${message}); paste it in a new session.`
  }

  return 'Paste it in the new session beside this one.'
}

// ---- The flow ----

// A module variable, not `$.state`: it only guards against two upgrades at
// once, and starting over on a reload is fine.
let isRunning = false

// The whole flow. Returns a line for the person: the command's output.
async function runUpgrade($: EngineInterface, provider: Provider, given: string): Promise<string> {
  if (isRunning) {
    return 'An upgrade is already running.'
  }

  // 1. The prompt: what was typed after /upgrade, else the draft in the box.
  const shortPrompt = given !== '' ? given : (await $.prompt.read()).text.trim()
  if (shortPrompt === '') {
    return 'Nothing to upgrade: type a prompt first, or use /upgrade -claude <prompt>.'
  }

  isRunning = true
  const name = NAMES[provider]

  try {
    // 2. Questions, written by the chosen provider.
    $.ui.status(`Prompt Upgrade: ${name} is choosing questions…`)
    const asked = await complete($, provider, questionsPrompt(shortPrompt))
    if (!asked.isOk) {
      return asked.reason
    }

    $.ui.status('Prompt Upgrade: waiting for your answers…')
    const answers: Answer[] = []
    for (const q of parseQuestions(asked.text)) {
      const answer = await $.ui.ask(q.question, { header: q.header, options: q.options })
      answers.push({ question: q.question, answer })
    }

    // 3. The rewrite, by the same provider.
    $.ui.status(`Prompt Upgrade: ${name} is rewriting your prompt…`)
    const rewritten = await complete($, provider, rewritePrompt(shortPrompt, answers))
    if (!rewritten.isOk) {
      return rewritten.reason
    }
    const upgraded = cleanReply(rewritten.text)

    // 4. Clipboard first, so the prompt is safe even if the pane fails to open.
    const copied = await $.ui.copy({ text: upgraded })
    if (!copied.isCopied) {
      // Without the clipboard there is nothing to paste: show the prompt instead.
      return `Upgraded with ${name}, but could not copy it (${copied.reason}):\n\n${upgraded}`
    }
    const opened = await openSidePane($)

    return `Upgraded with ${name} and copied. ${opened}\n\n${upgraded}`
  } catch (error) {
    // `$.ui.ask` rejects when the person dismisses a question: we stop there.
    const message = error instanceof Error ? error.message : String(error)
    return `Upgrade stopped: ${message}`
  } finally {
    isRunning = false
    $.ui.status(undefined)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'upgrade',
      description: 'Rewrite a short prompt into a detailed one: /upgrade [-claude|-codex] [prompt]',
    })

    return next(e)
  })

  on('command.run', { command: 'upgrade' }, async ($, e) => {
    const { provider, prompt } = parseArgs(e.args)
    const text = await runUpgrade($, provider, prompt).catch(error => `Upgrade failed: ${String(error)}`)
    return { text }
  })
}
