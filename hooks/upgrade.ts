// The pure part of Prompt Upgrade: no `$`, no model calls, only text in and
// text out. Keeping it here means the tests can check it without an engine.

import type { Provider, Question } from '../types'

export type ParsedArgs = { provider: Provider; prompt: string }

// Reads `/upgrade` arguments. A leading flag picks who rewrites:
// `-codex`, `--codex`, `- codex` (and the same for claude). No flag means Claude.
// Whatever follows the flag is the short prompt; it may be empty, in which
// case the caller upgrades the draft in the prompt box instead.
export function parseArgs(args: string): ParsedArgs {
  const match = args.trim().match(/^-{1,2}\s*(claude|codex)\b\s*/i)
  if (match === null) {
    return { provider: 'claude', prompt: args.trim() }
  }

  const provider = match[1]?.toLowerCase() === 'codex' ? 'codex' : 'claude'
  return { provider, prompt: args.trim().slice(match[0].length).trim() }
}

// Step 1: ask the provider which questions would help. We ask for JSON so we
// can turn the answer into `$.ui.ask` dialogs.
export function questionsPrompt(shortPrompt: string): string {
  return [
    'Someone wants to send this short prompt to an AI coding assistant:',
    '',
    '<prompt>',
    shortPrompt,
    '</prompt>',
    '',
    'Write 2 or 3 quick multiple-choice questions whose answers would most improve it',
    '(for example: the goal, the scope, constraints, the expected output).',
    'Each question has 2 to 4 short options. The person can also type their own answer.',
    '',
    'Reply with JSON only, no prose, no code fence, in exactly this shape:',
    '[{"header": "Scope", "question": "Which part should change?", "options": ["Only the login form", "The whole auth flow"]}]',
    'The header is at most 12 characters.',
  ].join('\n')
}

// Used when the provider's reply cannot be read as questions, so the flow
// still works instead of failing.
export const FALLBACK_QUESTIONS: readonly Question[] = [
  {
    header: 'Goal',
    question: 'What matters most in the result?',
    options: ['Correctness', 'Speed of delivery', 'Readable code', 'Learning how it works'],
  },
  {
    header: 'Output',
    question: 'What should the assistant hand back?',
    options: ['Code changes', 'An explanation', 'A plan first', 'A review'],
  },
]

// Turns the provider's reply into at most 3 valid questions, or the fallback.
// Models sometimes wrap JSON in prose or a code fence, so we cut out the part
// between the first `[` and the last `]` before parsing.
export function parseQuestions(reply: string): readonly Question[] {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start === -1 || end <= start) {
    return FALLBACK_QUESTIONS
  }

  let data: unknown
  try {
    data = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return FALLBACK_QUESTIONS
  }
  if (!Array.isArray(data)) {
    return FALLBACK_QUESTIONS
  }

  const questions: Question[] = []
  for (const item of data) {
    const question = toQuestion(item)
    if (question !== null) {
      questions.push(question)
    }
  }

  return questions.length > 0 ? questions.slice(0, 3) : FALLBACK_QUESTIONS
}

// One item of the JSON, checked field by field. `$.ui.ask` needs 2-4 options
// and a header of at most 12 characters, so we enforce that here.
function toQuestion(item: unknown): Question | null {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const { header, question, options } = item as Record<string, unknown>
  if (typeof question !== 'string' || question.trim() === '' || !Array.isArray(options)) {
    return null
  }

  const labels = options.filter((o): o is string => typeof o === 'string' && o.trim() !== '')
  if (labels.length < 2) {
    return null
  }

  return {
    header: typeof header === 'string' && header.trim() !== '' ? header.trim().slice(0, 12) : 'Detail',
    question: question.trim(),
    options: labels.slice(0, 4),
  }
}

export type Answer = { question: string; answer: string }

// Step 2: the rewrite itself, with the person's answers as context.
export function rewritePrompt(shortPrompt: string, answers: readonly Answer[]): string {
  const answerLines = answers.map(a => `- ${a.question} ${a.answer}`)

  return [
    'Rewrite this short prompt for an AI coding assistant into a detailed, specific prompt.',
    '',
    '<prompt>',
    shortPrompt,
    '</prompt>',
    '',
    'The person answered these questions about it:',
    ...answerLines,
    '',
    'The rewritten prompt should state the goal, the context, the scope, constraints,',
    'and what a good result looks like. Write it in the first person, as the person',
    'would send it. Do not invent facts about their codebase; where something is',
    'unknown, ask the assistant to find out.',
    '',
    'Reply with the rewritten prompt only: no preface, no explanation, no code fence.',
  ].join('\n')
}

// Models sometimes ignore "no code fence"; strip one if it wraps the whole reply.
export function cleanReply(reply: string): string {
  const trimmed = reply.trim()
  const fenced = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  return fenced?.[1] === undefined ? trimmed : fenced[1].trim()
}
