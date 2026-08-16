import type { Context } from '@deepseek-ai/cordis'

export const name = 'skill-injector-plugin'
export const inject = ['webServer', 'settings', 'skills', 'systemPrompt']

export function apply(ctx: Context): void {
  void ctx
}
