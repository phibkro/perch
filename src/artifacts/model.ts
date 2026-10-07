import { Lexer, type Tokens } from 'marked';
import type { StoredArtifact } from '../harness/durable';
import type { Artifact, ArtifactMessage, ArtifactTool } from './types';

const extensions: Record<string, string> = {
  markdown: 'md', md: 'md', mdx: 'mdx', html: 'html', htm: 'html',
  typescript: 'ts', ts: 'ts', tsx: 'tsx', javascript: 'js', js: 'js', jsx: 'jsx',
  python: 'py', py: 'py', rust: 'rs', rs: 'rs', kotlin: 'kt', kt: 'kt',
  swift: 'swift', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  csharp: 'cs', 'c#': 'cs', css: 'css', scss: 'scss', json: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql', xml: 'xml',
  svg: 'svg', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  go: 'go', ruby: 'rb', rb: 'rb', php: 'php', lua: 'lua',
  mermaid: 'mmd', diff: 'diff', text: 'txt', txt: 'txt', plaintext: 'txt',
};
const languageAliases: Record<string, string> = {
  md: 'markdown', htm: 'html', ts: 'typescript', js: 'javascript', py: 'python',
  rs: 'rust', kt: 'kotlin', yml: 'yaml', sh: 'bash', shell: 'bash',
  txt: 'text', plaintext: 'text', 'c++': 'cpp', 'c#': 'csharp',
};
const byExtension: Record<string, string> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', html: 'html', htm: 'html',
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  cjs: 'javascript', py: 'python', rs: 'rust', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp',
  css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', sql: 'sql', xml: 'xml', svg: 'svg', sh: 'bash', bash: 'bash',
  go: 'go', rb: 'ruby', php: 'php', lua: 'lua', mmd: 'mermaid', diff: 'diff',
};

/** Filenames are display/export names, never authority to read a host path. */
export function safeFilename(value: string, fallback = 'artifact.txt'): string {
  const leaf = value.normalize('NFKC').replace(/\\/g, '/').split('/').pop() || '';
  const safe = leaf
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 140);
  return safe && safe !== '.' && safe !== '..' ? safe : fallback;
}

export function languageForFilename(filename: string): string {
  return ownLanguage(byExtension, filename.split('.').pop()?.toLowerCase() || '') || 'text';
}

function ownLanguage(table: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

const languagesByMime: Record<string, string> = {
  'text/markdown': 'markdown', 'text/x-markdown': 'markdown', 'text/html': 'html',
  'text/javascript': 'javascript', 'application/javascript': 'javascript',
  'text/typescript': 'typescript', 'application/typescript': 'typescript',
  'application/json': 'json', 'application/ld+json': 'json', 'text/css': 'css',
  'application/xml': 'xml', 'text/xml': 'xml', 'image/svg+xml': 'svg',
  'text/yaml': 'yaml', 'application/yaml': 'yaml', 'application/x-yaml': 'yaml',
  'text/x-python': 'python', 'text/x-shellscript': 'bash',
};

/**
 * A manifest is enough to list a file, never enough to render its contents.
 * Only a recognized MIME opts into a rich reader. An HTML-looking name with
 * an unknown/plain MIME remains source, including SVG and executable projects.
 */
export function storedArtifactsToArtifacts(manifests: readonly StoredArtifact[]): Artifact[] {
  const artifacts = manifests.map((reference): Artifact => {
    const mime = reference.mimeType.split(';', 1)[0].trim().toLowerCase();
    const mimeLanguage = ownLanguage(languagesByMime, mime);
    const filename = safeFilename(reference.filename, 'artifact.' + (mimeLanguage ? extensions[mimeLanguage] : 'txt'));
    const declared = reference.language.trim().toLowerCase();
    const normalizedLanguage = ownLanguage(languageAliases, declared) || declared;
    const language = mimeLanguage || (mime === 'text/plain'
      ? (ownLanguage(extensions, normalizedLanguage) ? normalizedLanguage : languageForFilename(filename))
      : 'text');
    const title = reference.title.normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120) || filename;
    return {
      id: 'stored:' + encodeURIComponent(reference.sessionId) + ':' + encodeURIComponent(reference.id) + ':' + reference.sha256.toLowerCase(),
      title, filename, kind: mimeLanguage ? kindFor(mimeLanguage) : 'code', language,
      stored: { ...reference }, sourceId: reference.sourceId, sourceLabel: 'Saved artifact',
      createdAt: reference.createdAt, streaming: false,
    };
  });
  return [...new Map(artifacts.map(artifact => [artifact.id, artifact])).values()];
}

function kindFor(language: string): Artifact['kind'] {
  return language === 'markdown' || language === 'mdx' ? 'markdown'
    : language === 'html' ? 'html' : 'code';
}

function fenceInfo(info: string | undefined, index: number) {
  const value = (info || '').trim();
  const first = value.split(/\s+/)[0] || 'text';
  const attribute = value.match(/(?:^|\s)(?:file(?:name)?|title|path)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const bare = value.split(/\s+/).find(part => /^[\w./\\-]+\.[a-z\d]{1,12}$/i.test(part));
  const supplied = attribute?.[1] || attribute?.[2] || attribute?.[3] || bare;
  const knownLanguage = languageAliases[first.toLowerCase()] || first.toLowerCase();
  const language = supplied && !extensions[knownLanguage]
    ? languageForFilename(supplied)
    : knownLanguage.replace(/[^a-z\d+#-]/g, '') || 'text';
  const extension = extensions[language] || 'txt';
  const filename = safeFilename(supplied || 'snippet-' + (index + 1) + '.' + extension);
  return { language, filename, kind: kindFor(language) };
}

function titleFromMarkdown(content: string): string {
  const heading = content.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/m)?.[1];
  const firstLine = content.split('\n').map(line => line.trim()).find(Boolean) || 'Response';
  return (heading || firstLine).replace(/[*_~\x60]/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').slice(0, 78) || 'Response';
}

export function artifactForMessage(message: ArtifactMessage): Artifact {
  const title = titleFromMarkdown(message.text);
  const slug = title.toLowerCase().replace(/[^a-z\d]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return {
    id: 'message:' + message.id + ':document', title, filename: (slug || 'response') + '.md',
    kind: 'markdown', language: 'markdown', content: message.text,
    sourceId: 'message:' + message.id, sourceLabel: 'Assistant response', createdAt: message.createdAt,
    streaming: !!message.streaming,
  };
}

function codeArtifacts(text: string, sourceId: string, sourceLabel: string, createdAt: number, streaming: boolean): Artifact[] {
  const tokens = Lexer.lex(text, { gfm: true });
  const code = tokens.filter((token): token is Tokens.Code => token.type === 'code' && token.codeBlockStyle !== 'indented');
  return code.flatMap((token, index) => {
    if (!token.text.trim()) return [];
    const info = fenceInfo(token.lang, index);
    return [{
      ...info, id: sourceId + ':code:' + index, title: info.filename,
      content: token.text, sourceId, sourceLabel, createdAt, streaming,
    }];
  });
}

/**
 * Derived views never mutate chat history or request host files.
 * IDs are based on source identity/fence position, so streaming updates keep selection.
 */
export function deriveArtifacts(messages: readonly ArtifactMessage[], tools: readonly ArtifactTool[] = []): Artifact[] {
  const artifacts: Artifact[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.text.trim()) continue;
    const blocks = codeArtifacts(message.text, 'message:' + message.id, 'Assistant response', message.createdAt, !!message.streaming);
    // A long/rich response is itself a readable document. Short conversational
    // replies do not fill the artifact list, but can still be opened explicitly.
    const tokens = Lexer.lex(message.text, { gfm: true });
    const proseLength = tokens.filter(token => token.type !== 'code').reduce((n, token) => n + token.raw.trim().length, 0);
    if (proseLength >= 240 || tokens.some(token => token.type === 'heading' || token.type === 'table')) {
      artifacts.push(artifactForMessage(message));
    }
    artifacts.push(...blocks);
  }
  for (const tool of tools) {
    if (tool.artifact) {
      const filename = safeFilename(tool.artifact.filename);
      const language = languageAliases[tool.artifact.language || ''] || tool.artifact.language || languageForFilename(filename);
      artifacts.push({
        id: 'tool:' + tool.id + ':file', title: filename, filename, language,
        kind: kindFor(language), content: tool.artifact.content, sourceId: 'tool:' + tool.id,
        sourceLabel: tool.label, createdAt: 0, streaming: tool.status === 'running',
      });
    }
  }
  return [...new Map(artifacts.map(artifact => [artifact.id, artifact])).values()];
}

export function artifactStats(content: string) {
  return { lines: content.split('\n').length, characters: content.length };
}

export const MAX_RENDER_CHARACTERS = 200_000;
export const MAX_HIGHLIGHT_CHARACTERS = 50_000;
