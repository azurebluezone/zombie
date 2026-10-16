import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

/** Legacy parity: text listing with slash suffixes for directories. */
export async function execute(args = {}) {
  if (typeof args.path !== 'string' || !args.path) return textResult('Directory not found: .');
  try {
    const info = await stat(args.path);
    if (!info.isDirectory()) return textResult(`Not a directory: ${args.path}`);
    const entries = await readdir(args.path, { withFileTypes: true });
    const listing = entries.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name);
    return textResult(`Contents of ${args.path}:\n${listing.join('\n')}`);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return textResult(`Directory not found: ${args.path}`);
    return textResult(`Directory listing failed: ${args.path} (${error?.code ?? 'filesystem_error'})`);
  }
}
