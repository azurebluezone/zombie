import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

/** Legacy parity: create parent directories and return MCP text content. */
export async function execute(args = {}) {
  if (typeof args.path !== 'string' || !args.path) return textResult('path is required for write_file');
  if (typeof args.content !== 'string') return textResult('content is required for write_file');
  try {
    await mkdir(path.dirname(args.path), { recursive: true });
    await writeFile(args.path, args.content, 'utf8');
    // The legacy implementation reports JavaScript string length in its text.
    return textResult(`Written ${args.content.length} bytes to ${args.path}`);
  } catch (error) {
    return textResult(`Write failed: ${args.path} (${error?.code ?? 'filesystem_error'})`);
  }
}
