import type { ToolActivity } from '../session/types';
import { record } from './protocol';

/** Only full write inputs qualify. Edits, diffs, and success messages do not. */
export function writeArtifact(toolName: string, args: unknown): ToolActivity['artifact'] {
  if (toolName !== 'write' || !record(args) || typeof args.path !== 'string' || typeof args.content !== 'string') return undefined;
  return { filename: args.path, content: args.content };
}
