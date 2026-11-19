import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { decisionsFileSchema, publishedEvalResultsSchema, qualityResponseSchema } from '@app/shared';
import { extractMarkdownSection, parseKnownWeaknesses } from '../../content/quality-docs.js';

const thisDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Walks up from this module's own directory to find the repo root. Needed
 * because this file's depth relative to the repo root differs between dev
 * (`tsx`, running straight from `src/api/routes/`) and the built app
 * (`node`, running from the mirrored `src/dist/api/routes/`) — a marker
 * only the repo root has (`docs/KNOWN-WEAKNESSES.md`) is checked at each
 * level instead of hardcoding a relative `../..` depth.
 */
function resolveRepoRoot(startDir: string): string {
  let dir = startDir;
  while (!fs.existsSync(path.join(dir, 'docs', 'KNOWN-WEAKNESSES.md'))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate the repo root (docs/KNOWN-WEAKNESSES.md) above ${startDir}`);
    }
    dir = parent;
  }
  return dir;
}

const repoRoot = resolveRepoRoot(thisDir);

export interface QualityRouterDeps {
  evalResultsPath?: string;
  decisionsPath?: string;
  weaknessesDocPath?: string;
  rationaleDocPath?: string;
}

/**
 * `/api/quality` (Story 7.5). AD-28: behind the exact same `requireAuth`
 * gate as every other route in `app.ts` — no exception. AD-29: every
 * section is generated from an existing source, never hand-copied —
 * `evals` validates the committed eval report, `decisions` validates the
 * curated `src/content/decisions.json`, `weaknesses` is parsed from
 * `docs/KNOWN-WEAKNESSES.md`'s own pipe tables, and `reflection` is
 * extracted from `docs/TECHNICAL-RATIONALE.md`'s own "Agent vs. prompt
 * engineering vs. RAG" section.
 */
export function createQualityRouter({
  evalResultsPath = path.join(repoRoot, 'src/evals/published/eval-results.json'),
  decisionsPath = path.join(repoRoot, 'src/content/decisions.json'),
  weaknessesDocPath = path.join(repoRoot, 'docs/KNOWN-WEAKNESSES.md'),
  rationaleDocPath = path.join(repoRoot, 'docs/TECHNICAL-RATIONALE.md'),
}: QualityRouterDeps = {}) {
  const router = Router();

  router.get('/', (_req, res) => {
    const evals = publishedEvalResultsSchema.parse(JSON.parse(fs.readFileSync(evalResultsPath, 'utf8')));
    const decisions = decisionsFileSchema.parse(JSON.parse(fs.readFileSync(decisionsPath, 'utf8')));
    const weaknesses = parseKnownWeaknesses(fs.readFileSync(weaknessesDocPath, 'utf8'));
    const reflection = {
      agentVsPromptEngineeringVsRag: extractMarkdownSection(
        fs.readFileSync(rationaleDocPath, 'utf8'),
        'Agent vs. prompt engineering vs. RAG',
      ),
    };

    res.json(qualityResponseSchema.parse({ evals, decisions, weaknesses, reflection }));
  });

  return router;
}
