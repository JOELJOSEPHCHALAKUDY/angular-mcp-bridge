import type { ToolRegistry } from '@angular-mcp-bridge/contracts';
import { start, type EvaluationOptions } from './index.js';
import { assertChat, chatMatchers } from './matchers.js';

export type EvaluationDefaults = Partial<Pick<EvaluationOptions<ToolRegistry>, 'model' | 'instructions' | 'maxSteps' | 'timeoutMs' | 'temperature'>>;
export interface EvaluationSuiteAdapter {
  /** Supply Vitest onTestFinished, or an equivalent per-test lifecycle function. */
  onTestFinished?: (cleanup: () => Promise<void>) => void;
  /** Optional explicit matcher installation; no global mutation occurs by importing the package. */
  extend?: (matchers: typeof chatMatchers) => void;
  /** A getter can read runner-injected settings. Each suite owns its defaults. */
  defaults?: EvaluationDefaults | (() => EvaluationDefaults);
}
/** Optional test-runner integration via injected functions, with no runtime runner import. */
export function createEvaluationSuite(adapter: EvaluationSuiteAdapter = {}) {
  adapter.extend?.(chatMatchers);
  return {
    async start<T extends ToolRegistry>(options: Omit<EvaluationOptions<T>, 'model'> & { model?: EvaluationOptions<T>['model'] }) {
      const defaults = typeof adapter.defaults === 'function' ? adapter.defaults() : adapter.defaults ?? {};
      const resolved = { ...defaults, ...options, model: options.model ?? defaults.model };
      if (!resolved.model) throw new Error('Supply an evaluation model explicitly or in suite defaults.');
      const chat = await start({ ...resolved, model: resolved.model });
      try { adapter.onTestFinished?.(() => chat.close()); }
      catch (error) { await chat.close(); throw error; }
      return chat;
    },
    assert: assertChat,
    matchers: chatMatchers,
  };
}
