import { describe, expect, test } from 'claude-code/testing'

import { FALLBACK_QUESTIONS, cleanReply, parseArgs, parseQuestions, sidePaneCommand } from './upgrade'

describe('parseArgs', () => {
  test('defaults to Claude', () => {
    expect(parseArgs('fix the login bug')).toEqual({ provider: 'claude', prompt: 'fix the login bug' })
  })

  test('reads the codex flag in every spelling', () => {
    for (const args of ['-codex fix it', '--codex fix it', '- codex fix it', '-Codex fix it']) {
      expect(parseArgs(args)).toEqual({ provider: 'codex', prompt: 'fix it' })
    }
  })

  test('a flag alone means: upgrade the draft', () => {
    expect(parseArgs('-claude')).toEqual({ provider: 'claude', prompt: '' })
  })

  test('a dash later in the prompt is not a flag', () => {
    expect(parseArgs('rename foo -codex style')).toEqual({ provider: 'claude', prompt: 'rename foo -codex style' })
  })
})

describe('parseQuestions', () => {
  test('reads JSON wrapped in prose or a fence', () => {
    const reply = 'Sure:\n```json\n[{"header":"Scope","question":"Which part?","options":["A","B"]}]\n```'
    expect(parseQuestions(reply)).toEqual([{ header: 'Scope', question: 'Which part?', options: ['A', 'B'] }])
  })

  test('keeps the limits $.ui.ask needs', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      header: 'A very long header indeed',
      question: `Q${i}?`,
      options: ['1', '2', '3', '4', '5'],
    }))
    const questions = parseQuestions(JSON.stringify(many))
    expect(questions.length).toBe(3)
    expect(questions[0]?.header.length).toBe(12)
    expect(questions[0]?.options.length).toBe(4)
  })

  test('falls back when the reply is not usable', () => {
    expect(parseQuestions('I cannot do that')).toBe(FALLBACK_QUESTIONS)
    expect(parseQuestions('[not json]')).toBe(FALLBACK_QUESTIONS)
    expect(parseQuestions('[{"question":"Only one option?","options":["x"]}]')).toBe(FALLBACK_QUESTIONS)
  })
})

test('cleanReply strips a fence around the whole reply', () => {
  expect(cleanReply('```\nDo the thing.\n```')).toBe('Do the thing.')
  expect(cleanReply('  Do the thing.  ')).toBe('Do the thing.')
})

describe('sidePaneCommand', () => {
  test('splits tmux side by side, in the same folder', () => {
    expect(sidePaneCommand({ isTmux: true, isWindowsTerminal: false }, '/repo')).toEqual([
      'tmux', 'split-window', '-h', '-c', '/repo', 'claude',
    ])
  })

  test('splits Windows Terminal side by side, in the same folder', () => {
    expect(sidePaneCommand({ isTmux: false, isWindowsTerminal: true }, 'C:\\repo')).toEqual([
      'wt', '-w', '0', 'split-pane', '-V', '-d', 'C:\\repo', 'claude',
    ])
  })

  test('prefers tmux when tmux runs inside Windows Terminal', () => {
    expect(sidePaneCommand({ isTmux: true, isWindowsTerminal: true }, '/repo')?.[0]).toBe('tmux')
  })

  test('gives up on any other terminal', () => {
    expect(sidePaneCommand({ isTmux: false, isWindowsTerminal: false }, '/repo')).toBeNull()
  })
})

// End to end, with the outside world faked beneath the plugin. The test's own
// hooks stand where the engine would: `process.run` (Codex and the terminal),
// `AskUserQuestion` (the person), `ui.copy` (the clipboard), `env.get` (which
// terminal this is) and `session.cwd`.

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('/upgrade-prompt -codex asks, copies the rewrite, then opens a tmux pane', async ($, on) => {
  const commands: string[][] = []
  const codexInputs: string[] = []
  const copied: string[] = []
  on('process.run', ($, e) => {
    commands.push([...e.argv])
    if (e.argv[0] !== 'codex') {
      return ran('')
    }
    codexInputs.push(e.init?.stdin ?? '')
    return codexInputs.length === 1
      ? ran('[{"header":"Scope","question":"Which part?","options":["Login form","Whole auth"]}]')
      : ran('Fix the login form so it shows an error on a wrong password.')
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({
    result: { questions: e.questions, answers: { 'Which part?': 'Login form' } },
  }))
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('env.get', ($, e) => ({ value: e.name === 'TMUX' ? '/tmp/tmux-1/default,1,0' : undefined }))
  on('session.cwd', () => ({ value: '/repo' }))

  const result = await $.command.run({ ...RUN, command: 'upgrade-prompt', args: '-codex fix login' })

  expect(result.text).toContain('Upgraded with Codex and copied')
  expect(codexInputs[0]).toContain('fix login')
  expect(codexInputs[1]).toContain('Which part? Login form')
  expect(copied).toEqual(['Fix the login form so it shows an error on a wrong password.'])
  // The pane opens last, after both Codex calls.
  expect(commands.map(c => c[0])).toEqual(['codex', 'codex', 'tmux'])
  expect(commands[2]).toEqual(['tmux', 'split-window', '-h', '-c', '/repo', 'claude'])
})

test('a missing codex CLI is reported, and nothing is copied or opened', async ($, on) => {
  const commands: string[][] = []
  on('process.run', ($, e) => {
    commands.push([...e.argv])
    return { deny: 'codex: not found' }
  })

  const result = await $.command.run({ ...RUN, command: 'upgrade-prompt', args: '-codex fix login' })

  expect(result.text).toContain('Could not run Codex')
  expect(commands.length).toBe(1)
})

test('/upgrade-prompt with no flag goes to Claude, upgrades the draft, and shows it when the clipboard fails', async ($, on) => {
  const models: string[] = []
  const commands: string[][] = []
  on('prompt.read', () => ({ value: { text: 'add dark mode', cursor: 13 } }))
  on('model.complete', ($, e) => {
    models.push(e.model)
    const text = models.length === 1
      ? '[{"header":"Where","question":"Which screens?","options":["All","Settings only"]}]'
      : 'Add a dark mode to every screen.'
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({
    result: { questions: e.questions, answers: { 'Which screens?': 'All' } },
  }))
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
  on('process.run', ($, e) => {
    commands.push([...e.argv])
    return ran('')
  })

  const result = await $.command.run({ ...RUN, command: 'upgrade-prompt', args: '' })

  expect(models).toEqual(['sonnet', 'sonnet'])
  expect(result.text).toContain('could not copy it (no-clipboard)')
  expect(result.text).toContain('Add a dark mode to every screen.')
  // Nothing to paste, so no pane.
  expect(commands).toEqual([])
})
