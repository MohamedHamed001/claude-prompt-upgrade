// Prompt Upgrade's type contract: the shapes it keeps in `$.state`.

export type Provider = 'claude' | 'codex'

export type Question = { header: string; question: string; options: string[] }

// What the band shows: nothing, an upgrade in progress, or a finished one.
export type Upgrade =
  | { status: 'idle' }
  | { status: 'working'; provider: Provider; step: string }
  | { status: 'done'; provider: Provider; original: string; upgraded: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': { upgrade: Upgrade }
  }
}
