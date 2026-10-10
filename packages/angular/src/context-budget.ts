/** Library heuristics for developer diagnostics; these are not host-enforced limits. */
export const CONTEXT_WARNING_DEFAULTS = Object.freeze({ toolResultTokens: 5_000, modelContextTokens: 20_000, bytesPerToken: 4 });

export interface ContextSizeOptions {
  /** A rough UTF-8 bytes/token ratio, rather than a model-specific tokenizer. */
  bytesPerToken?: number;
  /** Exclude protocol-private, top-level _meta. Defaults to true. */
  omitPrivateMetadata?: boolean;
}
export interface ContextSize {
  utf8Bytes: number | null;
  estimatedTokens: number | null;
  bytesPerToken: number;
  serializable: boolean;
  excludedPrivateMetadata: boolean;
  /** A failed estimate is never reported as a zero-sized payload. */
  reason?: 'not-json' | 'serialization-failed';
}
export interface ContextBudgetOptions extends ContextSizeOptions { budgetTokens: number; }
export interface ContextBudgetCheck extends ContextSize {
  budgetTokens: number;
  /** Null means the payload could not be measured. Equality reaches the budget. */
  exceeded: boolean | null;
}
export interface ContextWarning extends ContextBudgetCheck {
  kind: 'tool-result' | 'model-context';
  source: 'callTool' | 'toolResult' | 'setModelContext';
  toolName?: string;
}
export interface ContextDiagnosticsOptions {
  /** Only used when onContextWarning is installed. No payload is blocked or truncated. */
  contextBudget?: {
    toolResultTokens?: number;
    modelContextTokens?: number;
    bytesPerToken?: number;
  };
  /** Opt-in, data-free diagnostics. Exceptions in this observer do not interrupt bridge work. */
  onContextWarning?: (warning: ContextWarning) => void | Promise<void>;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite.`);
  return value;
}
/** Measure JSON as UTF-8, excluding protocol-private metadata by default. */
export function estimateContextSize(value: unknown, options: ContextSizeOptions = {}): ContextSize {
  const bytesPerToken = positive(options.bytesPerToken ?? CONTEXT_WARNING_DEFAULTS.bytesPerToken, 'bytesPerToken');
  const excludedPrivateMetadata = options.omitPrivateMetadata ?? true;
  const base = { bytesPerToken, excludedPrivateMetadata };
  if (value === undefined) return { ...base, utf8Bytes: 0, estimatedTokens: 0, serializable: true };
  try {
    let visible = value;
    if (excludedPrivateMetadata && value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '_meta')) {
      const { _meta, ...publicFields } = value as Record<string, unknown>;
      visible = publicFields;
    }
    const serialized = JSON.stringify(visible);
    if (serialized === undefined) return { ...base, utf8Bytes: null, estimatedTokens: null, serializable: false, reason: 'not-json' };
    const utf8Bytes = new TextEncoder().encode(serialized).byteLength;
    return { ...base, utf8Bytes, estimatedTokens: Math.ceil(utf8Bytes / bytesPerToken), serializable: true };
  } catch {
    return { ...base, utf8Bytes: null, estimatedTokens: null, serializable: false, reason: 'serialization-failed' };
  }
}
/** Compare an estimate with an explicit developer budget, without mutating the payload. */
export function checkContextBudget(value: unknown, options: ContextBudgetOptions): ContextBudgetCheck {
  const budgetTokens = positive(options.budgetTokens, 'budgetTokens');
  const size = estimateContextSize(value, options);
  return { ...size, budgetTokens, exceeded: size.estimatedTokens === null ? null : size.estimatedTokens >= budgetTokens };
}
