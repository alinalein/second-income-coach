import type { EvaluationWeaknesses, EvaluationTools } from '@app/shared';

/**
 * Story 7.5 / AD-29: the Reflection section's weaknesses/edge-cases/
 * improvements content and the "Agent vs. prompt engineering vs. RAG"
 * guidance are both parsed from `docs/KNOWN-WEAKNESSES.md` and
 * `docs/TECHNICAL-RATIONALE.md` directly, never a hand-typed second copy.
 */

function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

function parsePipeRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Returns the data rows (header + separator rows dropped) of the pipe
 * table immediately following a `## <heading>` (or, with `headingMarker`
 * set to `'###'`, a `### <heading>`) line. */
function findTableDataRows(markdown: string, heading: string, headingMarker: '##' | '###' = '##'): string[][] {
  const lines = markdown.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === `${headingMarker} ${heading}`);
  if (headingIndex === -1) {
    throw new Error(`docs: heading "${headingMarker} ${heading}" not found`);
  }

  let i = headingIndex + 1;
  while (i < lines.length && !isTableRow(lines[i]!)) i++;

  const rows: string[][] = [];
  while (i < lines.length && isTableRow(lines[i]!)) {
    rows.push(parsePipeRow(lines[i]!));
    i++;
  }

  return rows.slice(2); // drop the header row and the `---` separator row
}

/** Parses the three pipe tables (`KW-`, `EC-`, `CI-` rows) in
 * `docs/KNOWN-WEAKNESSES.md` into `/api/evaluation`'s `weaknesses` shape. */
export function parseKnownWeaknesses(markdown: string): EvaluationWeaknesses {
  const knownWeaknesses = findTableDataRows(markdown, 'Known weaknesses & improvement suggestions').map(
    ([id, weakness, impact, suggestion]) => ({ id: id!, weakness: weakness!, impact: impact!, suggestion: suggestion! }),
  );
  const edgeCases = findTableDataRows(markdown, 'Edge cases and potential problems').map(
    ([id, scenario, whatHappens, suggestion]) => ({ id: id!, scenario: scenario!, whatHappens: whatHappens!, suggestion: suggestion! }),
  );
  const codeImprovements = findTableDataRows(markdown, 'Code improvement suggestions').map(
    ([id, suggestion, why]) => ({ id: id!, suggestion: suggestion!, why: why! }),
  );

  return { knownWeaknesses, edgeCases, codeImprovements };
}

/**
 * Story 7.5/7.2: parses the two `### `-level tables under `docs/
 * TECHNICAL-RATIONALE.md`'s own "## Tool boundary: LLM-backed vs.
 * plain-code vs. MCP" section into `/api/evaluation`'s `tools` shape —
 * never a hand-typed second copy of either table.
 */
export function parseToolsSection(markdown: string): EvaluationTools {
  const agentTools = findTableDataRows(markdown, 'Which tools each agent can call', '###').map(
    ([whereUserIs, agentThread, toolsModelCanCall]) => ({ whereUserIs: whereUserIs!, agentThread: agentThread!, toolsModelCanCall: toolsModelCanCall! }),
  );
  const toolDetails = findTableDataRows(markdown, 'What each tool does', '###').map(
    ([tool, kind, whoCallsIt, whereInFlow, whatItDoes, writesState]) => ({
      tool: tool!,
      kind: kind!,
      whoCallsIt: whoCallsIt!,
      whereInFlow: whereInFlow!,
      whatItDoes: whatItDoes!,
      writesState: writesState!,
    }),
  );

  return { agentTools, toolDetails };
}

/** Parses a `## <heading>` section's own `- ` bullet lines (up to the
 * next `## ` heading, or end of file) into one string per bullet — used
 * to pull the "Agent vs. prompt engineering vs. RAG" section out of
 * `docs/TECHNICAL-RATIONALE.md` (itself a bulleted list, UX fix: "this in
 * bullet points") as structured data, never a hand-typed second copy and
 * never a single prose blob the page would have to re-split on its own. */
export function extractMarkdownBulletList(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (startIndex === -1) {
    throw new Error(`docs/TECHNICAL-RATIONALE.md: heading "## ${heading}" not found`);
  }

  let endIndex = lines.findIndex((line, index) => index > startIndex && /^##\s/.test(line.trim()));
  if (endIndex === -1) endIndex = lines.length;

  return lines
    .slice(startIndex + 1, endIndex)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}
