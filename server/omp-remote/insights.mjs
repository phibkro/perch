import { isThinkingLevel, parseSessionInsights } from '../../src/harness/insights.ts';

const count = value => Number.isSafeInteger(value) && value >= 0;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : '';

/** Use the model's declared effort ladder. OMP still applies its own session ceiling. */
export function thinkingOptions(api, context) {
  if (typeof api.getThinkingLevel !== 'function' || typeof api.setThinkingLevel !== 'function') return undefined;
  const model = context.models?.current?.() ?? context.model;
  const efforts = model?.reasoning === true && Array.isArray(model.thinking?.efforts)
    ? model.thinking.efforts.filter(isThinkingLevel).slice(0, 31) : [];
  const availableLevels = [...new Set(efforts.length && !model.thinking?.requiresEffort ? ['off', ...efforts] : efforts)];
  const level = api.getThinkingLevel();
  return { ...(isThinkingLevel(level) ? { level } : {}), availableLevels };
}

/** Public extension reads only; no private InteractiveMode or provider objects cross this seam. */
export function projectInsights(api, context, entries) {
  const result = {};
  try {
    const value = context.getContextUsage?.();
    if (value) result.context = parseSessionInsights({ context: value }).context;
  } catch { /* OMP may have no current context estimate, for example after compaction. */ }
  try { const thinking = thinkingOptions(api, context); if (thinking) result.thinking = thinking; } catch {}
  let turns = 0, costs = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, scope: 'current-branch' };
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const value = entry.message.usage;
    if (!value || !count(value.input) || !count(value.output)
        || value.cacheRead !== undefined && !count(value.cacheRead) || value.cacheWrite !== undefined && !count(value.cacheWrite)) continue;
    turns++;
    usage.input += value.input; usage.output += value.output;
    usage.cacheRead += value.cacheRead ?? 0; usage.cacheWrite += value.cacheWrite ?? 0;
    if (money(value.cost?.total)) { usage.cost += value.cost.total; costs++; }
  }
  if (turns) {
    if (costs !== turns) delete usage.cost; // An absent report is not a zero-priced turn.
    try { result.usage = parseSessionInsights({ usage }).usage; } catch {}
  }
  if (typeof api.getAllTools === 'function' && typeof api.getActiveTools === 'function') {
    try {
      const active = new Set(api.getActiveTools()), names = new Set();
      result.tools = api.getAllTools().flatMap(tool => {
        const name = text(tool.name, 256);
        if (!name || names.has(name)) return [];
        names.add(name);
        return [{ name, description: text(tool.description, 512), active: active.has(tool.name) }];
      }).slice(0, 256);
    } catch {}
  }
  return parseSessionInsights(result);
}
