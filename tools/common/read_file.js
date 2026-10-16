import { readFile, stat } from 'node:fs/promises';

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

/**
 * Compatibility contract sourced from legacy api.js MCP_TOOLS.read_file:
 * MCP text-content envelope, human-readable missing/not-file errors and a
 * 100,000-character output ceiling. Path containment is enforced upstream by
 * ToolExecutionAdapter; this module never expands the allowed root itself.
 */
export async function execute(args = {}) {
  if (typeof args.path !== 'string' || !args.path) return textResult('File not found: .');
  try {
    const info = await stat(args.path);
    if (!info.isFile()) return textResult(`Not a file: ${args.path}`);
    const content = await readFile(args.path, 'utf8');
    return textResult(content.slice(0, 100000));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return textResult(`File not found: ${args.path}`);
    return textResult(`Read failed: ${args.path} (${error?.code ?? 'filesystem_error'})`);
  }
}
