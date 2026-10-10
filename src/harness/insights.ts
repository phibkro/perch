import type { SessionInsights } from '../session/types.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
export const isThinkingLevel = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
function invalid(): never { throw new Error('Invalid host session details.'); }

/** Projects display facts only, never provider credentials or executable tool schemas. */
export function parseSessionInsights(input: unknown): SessionInsights {
  if (!record(input)) invalid();
  const result: SessionInsights = {};
  if (input.context !== undefined) {
    const value = input.context;
    if (!record(value) || !count(value.tokens) || !count(value.contextWindow) || value.contextWindow === 0
        || !finite(value.percent) || value.percent > 10_000) invalid();
    result.context = { tokens: value.tokens, contextWindow: value.contextWindow, percent: value.percent };
  }
  if (input.thinking !== undefined) {
    const value = input.thinking;
    if (!record(value) || value.level !== undefined && !isThinkingLevel(value.level)
        || !Array.isArray(value.availableLevels) || value.availableLevels.length > 32
        || !value.availableLevels.every(isThinkingLevel) || new Set(value.availableLevels).size !== value.availableLevels.length) invalid();
    result.thinking = { ...(value.level === undefined ? {} : { level: value.level as string }), availableLevels: [...value.availableLevels] };
  }
  if (input.usage !== undefined) {
    const value = input.usage;
    if (!record(value) || value.scope !== 'current-branch' || !count(value.input) || !count(value.output)
        || !count(value.cacheRead) || !count(value.cacheWrite) || value.cost !== undefined && !finite(value.cost)) invalid();
    result.usage = { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite,
      scope: 'current-branch', ...(value.cost === undefined ? {} : { cost: value.cost as number }) };
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length > 256) invalid();
    const names = new Set<string>();
    result.tools = input.tools.map(value => {
      if (!record(value) || !text(value.name, 256) || !value.name || names.has(value.name)
          || !text(value.description, 512) || typeof value.active !== 'boolean') invalid();
      names.add(value.name);
      return { name: value.name, description: value.description, active: value.active };
    });
  }
  return result;
}
