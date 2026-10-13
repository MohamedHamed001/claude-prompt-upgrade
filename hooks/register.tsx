// Prompt Upgrade: `/upgrade [-claude|-codex] [prompt]`, or the band's two
// buttons, turn a short prompt into a detailed one. The flow is:
//   1. pick the prompt (the argument, or the draft in the prompt box)
//   2. the chosen provider writes 2-3 questions; we ask them with `$.ui.ask`
//   3. the same provider rewrites the prompt using the answers
//   4. the band shows the result with Edit / Copy / Run

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Provider, Upgrade } from '../types'
import type { Answer } from './upgrade'
import { cleanReply, parseArgs, parseQuestions, questionsPrompt, rewritePrompt } from './upgrade'

const IDLE: Upgrade = { status: 'idle' }
const upgrade = atom({ plugin: 'prompt-upgrade', key: 'upgrade' } as const, IDLE)

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

// ---- The flow ----

// The whole flow. Returns a line for the person (the command's output, or a
// toast when a button started it). Every step updates the band so the person
// can see where it is.
async function runUpgrade($: EngineInterface, provider: Provider, given: string): Promise<string> {
  if ((await read($, upgrade)).status === 'working') {
    return 'An upgrade is already running.'
  }

  // 1. The prompt: what was typed after /upgrade, else the draft in the box.
  const shortPrompt = given !== '' ? given : (await $.prompt.read()).text.trim()
  if (shortPrompt === '') {
    return 'Nothing to upgrade: type a prompt first, or use /upgrade -claude <prompt>.'
  }

  const setStep = (step: string) => update($, upgrade, (): Upgrade => ({ status: 'working', provider, step }))
  const name = NAMES[provider]

  try {
    // 2. Questions, written by the chosen provider.
    await setStep(`${name} is choosing questions…`)
    const asked = await complete($, provider, questionsPrompt(shortPrompt))
    if (!asked.isOk) {
      return asked.reason
    }

    const answers: Answer[] = []
    for (const q of parseQuestions(asked.text)) {
      await setStep('Waiting for your answers…')
      const answer = await $.ui.ask(q.question, { header: q.header, options: q.options })
      answers.push({ question: q.question, answer })
    }

    // 3. The rewrite, by the same provider.
    await setStep(`${name} is rewriting your prompt…`)
    const rewritten = await complete($, provider, rewritePrompt(shortPrompt, answers))
    if (!rewritten.isOk) {
      return rewritten.reason
    }

    // 4. Hand it to the band.
    const upgraded = cleanReply(rewritten.text)
    await update($, upgrade, (): Upgrade => ({ status: 'done', provider, original: shortPrompt, upgraded }))
    return `Upgraded with ${name}. Edit, Copy or Run it from the band above the prompt.`
  } catch (error) {
    // `$.ui.ask` rejects when the person dismisses a question: we stop there.
    const message = error instanceof Error ? error.message : String(error)
    return `Upgrade stopped: ${message}`
  } finally {
    // Whatever happened, never leave the band stuck on "working".
    await update($, upgrade, current => (current.status === 'working' ? IDLE : current))
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, upgrade)

    // A button press starts the flow; its result line shows as a toast.
    const start = async (provider: Provider) => $.ui.toast(await runUpgrade($, provider, ''))

    if (state.status === 'working') {
      return (
        <Box>
          <Text dimColor>Prompt Upgrade: {state.step}</Text>
        </Box>
      )
    }

    if (state.status === 'done') {
      const close = () => update($, upgrade, () => IDLE)
      const edit = async () => {
        await $.prompt.fill({ text: state.upgraded, mode: 'replace' })
        await close()
      }
      const copy = async () => {
        const copied = await $.ui.copy({ text: state.upgraded, surface: e.surface })
        $.ui.toast(copied.isCopied ? 'Copied the upgraded prompt.' : `Could not copy (${copied.reason}).`)
      }
      const run = async () => {
        await close()
        await $.prompt.submit({ text: state.upgraded })
      }

      return (
        <Box flexDirection="column">
          <Text dimColor>Upgraded by {NAMES[state.provider]}:</Text>
          <Text wrap="wrap">{preview(state.upgraded)}</Text>
          <Box>
            <Button key="edit" label="Edit" variant="primary" onPress={edit} />
            <Button key="copy" label="Copy" onPress={copy} />
            <Button key="run" label="Run" onPress={run} />
            <Button key="close" label="Dismiss" role="dismiss" onPress={close} />
          </Box>
        </Box>
      )
    }

    return (
      <Box>
        <Text dimColor>Upgrade your draft: </Text>
        <Button key="claude" label="Claude" dimColor onPress={() => start('claude')} />
        <Button key="codex" label="Codex" dimColor onPress={() => start('codex')} />
      </Box>
    )
  })
}

// The band is small; show the first lines and say how much more there is.
function preview(text: string): string {
  const lines = text.split('\n')
  const shown = lines.slice(0, 4).join('\n')
  return lines.length > 4 ? `${shown}\n… ${lines.length - 4} more lines (Edit to see it all)` : shown
}
