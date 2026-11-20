import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseToolsSection } from './evaluation-docs.js';

const thisDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.join(thisDir, '..', '..');
const rationaleDocPath = path.join(repoRoot, 'docs/TECHNICAL-RATIONALE.md');
const rationaleDoc = fs.readFileSync(rationaleDocPath, 'utf8');

const TOOL_KINDS = ['llm', 'plain', 'mcp'] as const;

/** Story 7.5/7.2: "one test that every tool name in the table exists in
 * src/tools (so the doc cannot drift)" — reads the real, committed doc (not
 * a fixture), so a tool renamed or removed under `src/tools/` without
 * updating `docs/TECHNICAL-RATIONALE.md`'s own "What each tool does" table
 * fails this test immediately, not silently. */
describe('parseToolsSection (Story 7.5/7.2: "What each tool does" cannot drift from src/tools)', () => {
  it('every tool name in the table is a real file under src/tools/{llm,plain,mcp}/', () => {
    const { toolDetails } = parseToolsSection(rationaleDoc);
    expect(toolDetails.length).toBeGreaterThan(0);

    for (const row of toolDetails) {
      const toolName = row.tool.replace(/`/g, '');
      const existsSomewhere = TOOL_KINDS.some((kind) => fs.existsSync(path.join(repoRoot, 'src/tools', kind, `${toolName}.ts`)));
      expect(existsSomewhere, `"${toolName}" (from the doc's "What each tool does" table) has no matching src/tools/*/${toolName}.ts file`).toBe(true);
    }
  });

  it('every real tool file under src/tools/{llm,plain,mcp}/ is named in the table (nothing silently undocumented)', () => {
    const { toolDetails } = parseToolsSection(rationaleDoc);
    const documented = new Set(toolDetails.map((row) => row.tool.replace(/`/g, '')));
    // Support files that are never tools themselves (no `create*Tool`/`tool()`
    // export of their own) — excluded the same way a reviewer reading
    // `src/tools/plain/` would exclude them, never by guessing.
    const NOT_A_TOOL = new Set(['step-state', 'usage_limits', 'check-in-tools']);

    for (const kind of TOOL_KINDS) {
      const dir = path.join(repoRoot, 'src/tools', kind);
      const toolFiles = fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .map((file) => file.replace(/\.ts$/, ''))
        .filter((name) => !NOT_A_TOOL.has(name));

      for (const toolFile of toolFiles) {
        expect(documented.has(toolFile), `src/tools/${kind}/${toolFile}.ts has no row in the doc's "What each tool does" table`).toBe(true);
      }
    }
  });
});
