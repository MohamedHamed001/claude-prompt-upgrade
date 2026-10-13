// Prompt Upgrade's shared types. It keeps nothing in `$.state`.

export type Provider = 'claude' | 'codex'

export type Question = { header: string; question: string; options: string[] }
