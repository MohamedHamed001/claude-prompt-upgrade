import { describe, expect, test } from 'claude-code/testing'

import { FALLBACK_QUESTIONS, cleanReply, parseArgs, parseQuestions } from './upgrade'

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

// End to end, with Codex and the person faked beneath the plugin. The test's
// own hooks stand where the engine would: they answer `process.run` (Codex),
// `AskUserQuestion` (the person) and `prompt.fill` (the prompt box).

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
const BAND = {
  plugin: 'prompt-upgrade',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { bodyRows: 11, offset: 0 },
    view: {},
  },
} as const

const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('/upgrade -codex asks the questions, then offers the rewrite', async ($, on) => {
  const codexInputs: string[] = []
  const filled: string[] = []
  on('process.run', ($, e) => {
    codexInputs.push(e.init?.stdin ?? '')
    return codexInputs.length === 1
      ? ran('[{"header":"Scope","question":"Which part?","options":["Login form","Whole auth"]}]')
      : ran('Fix the login form so it shows an error on a wrong password.')
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({
    result: { questions: e.questions, answers: { 'Which part?': 'Login form' } },
  }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  const result = await $.command.run({ ...RUN, command: 'upgrade', args: '-codex fix login' })

  expect(result.text).toContain('Upgraded with Codex')
  expect(codexInputs.length).toBe(2)
  expect(codexInputs[0]).toContain('fix login')
  expect(codexInputs[1]).toContain('Which part? Login form')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Upgraded by Codex/ })).toBeDefined()
  await band.press({ key: 'edit' })
  expect(filled).toEqual(['Fix the login form so it shows an error on a wrong password.'])
})

test('a missing codex CLI is reported, and the band goes back to idle', async ($, on) => {
  on('process.run', () => ({ deny: 'codex: not found' }))

  const result = await $.command.run({ ...RUN, command: 'upgrade', args: '-codex fix login' })

  expect(result.text).toContain('Could not run Codex')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'codex' })).toBeDefined()
})

test('/upgrade with no flag goes to Claude and upgrades the draft', async ($, on) => {
  const models: string[] = []
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

  const result = await $.command.run({ ...RUN, command: 'upgrade', args: '' })

  expect(result.text).toContain('Upgraded with Claude')
  expect(models).toEqual(['sonnet', 'sonnet'])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Add a dark mode/ })).toBeDefined()
})
