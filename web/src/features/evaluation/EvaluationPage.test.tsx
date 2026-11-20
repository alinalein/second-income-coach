import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { EvaluationResponse } from '@app/shared';
import { EvaluationPage } from './EvaluationPage';
import i18n from '../../i18n';

function mockFetch(response: EvaluationResponse) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(response), { status: 200 })));
}

function basePayload(): EvaluationResponse {
  return {
    evals: {
      runDate: '2026-11-19T19:31:00.000Z',
      reportGeneratedAt: '2026-11-19T19:31:05.000Z',
      trajectoryAccuracyTarget: 0.8,
      perModelAccuracy: [{ modelId: 'openai/gpt-6-luna', deterministicCaseCount: 10, passedCaseCount: 9, accuracy: 0.9, meetsTarget: true }],
      judges: { judgeModelIds: ['google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash'], judgeScoredModels: {}, registryOverlap: [], qualityResults: [] },
      safety: { suites: [], allBuiltSuitesPassed: false, pending: [] },
      mistralJailbreakFlagRate: { status: 'pending', reason: 'not recorded' },
      cost: {
        perModel: [{ modelId: 'openai/gpt-6-luna', role: 'target', inputTokens: 1000, outputTokens: 500, callCount: 5, pricePerMillionInputTokens: 0.1, pricePerMillionOutputTokens: 0.5, estimatedCostUsd: 0.00035, usageComplete: true }],
        totalEstimatedCostUsd: 0.00035,
        totalLabel: 'target models',
        mechanism: 'eval-only-price-table',
      },
      limitations: [{ id: 'story-7-4-pending', summary: 'pending' }],
    },
    decisions: [],
    weaknesses: { knownWeaknesses: [], edgeCases: [], codeImprovements: [] },
    reflection: { agentVsPromptEngineeringVsRag: ['one bullet'] },
    tools: {
      agentTools: [{ whereUserIs: 'Intake and idea discovery (chat)', agentThread: 'discovery agent', toolsModelCanCall: '`submit_intake`, `generate_ideas`' }],
      toolDetails: [
        { tool: '`generate_ideas`', kind: 'LLM-backed', whoCallsIt: 'Model', whereInFlow: 'Ideas', whatItDoes: 'Generates ideas.', writesState: 'Yes — `ideas`' },
      ],
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  void i18n.changeLanguage('en');
});

/** User-requested (2026-11-20, Job A): proves the Latency table actually
 * appears and shows real per-model rows once the published payload carries
 * a `latency` block — this never had a test before, which is exactly how
 * "never showed" went unnoticed three times. */
describe('EvaluationPage (Job A: Latency table)', () => {
  it('renders the Latency table with model rows once the payload carries a latency block', async () => {
    const payload = basePayload();
    payload.evals.latency = {
      ackByModel: [{ modelId: 'openai/gpt-6-luna', medianMs: 420, maxMs: 900, calls: 5 }],
      deterministicByModel: [{ modelId: 'openai/gpt-6-luna', medianMs: null }],
    };
    vi.stubGlobal('fetch', mockFetch(payload));

    render(<EvaluationPage />);

    await waitFor(() => expect(screen.getByText('Latency')).toBeInTheDocument());
    expect(screen.getAllByText('openai/gpt-6-luna').length).toBeGreaterThan(0);
    expect(screen.getByText('420 ms')).toBeInTheDocument();
    expect(screen.getByText('900 ms')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('never renders the Latency table when the payload has no latency block (backward compatibility)', async () => {
    vi.stubGlobal('fetch', mockFetch(basePayload()));

    render(<EvaluationPage />);

    await waitFor(() => expect(screen.getAllByText('openai/gpt-6-luna').length).toBeGreaterThan(0));
    expect(screen.queryByText('Latency')).not.toBeInTheDocument();
  });

  // User-requested (2026-11-20, amended): no model has a recorded
  // deterministicByModel value yet (the cheap `npm run eval:latency`
  // measurement only ever fills the ack columns) — the trajectory-case
  // column must disappear entirely, never render as a column of nothing
  // but "Not measured", and the caption must only describe what's shown.
  it('hides the Trajectory case column and uses the ack-only caption when no model has trajectory data', async () => {
    const payload = basePayload();
    payload.evals.latency = {
      ackByModel: [{ modelId: 'openai/gpt-6-luna', medianMs: 420, maxMs: 900, calls: 5 }],
      deterministicByModel: [{ modelId: 'openai/gpt-6-luna', medianMs: null }],
    };
    vi.stubGlobal('fetch', mockFetch(payload));

    render(<EvaluationPage />);

    await waitFor(() => expect(screen.getByText('Latency')).toBeInTheDocument());
    expect(screen.queryByText('Trajectory case (median)')).not.toBeInTheDocument();
    expect(screen.queryByText(/versus a full deterministic trajectory case/)).not.toBeInTheDocument();
    expect(screen.getByText('Per model: the one direct start-step acknowledgment model call (5 real calls).')).toBeInTheDocument();
  });

  it('shows the Trajectory case column and the full caption once at least one model has trajectory data', async () => {
    const payload = basePayload();
    payload.evals.latency = {
      ackByModel: [
        { modelId: 'openai/gpt-6-luna', medianMs: 420, maxMs: 900, calls: 5 },
        { modelId: 'anthropic/claude-haiku-4.5', medianMs: 500, maxMs: 950, calls: 5 },
      ],
      deterministicByModel: [
        { modelId: 'openai/gpt-6-luna', medianMs: null },
        { modelId: 'anthropic/claude-haiku-4.5', medianMs: 1200 },
      ],
    };
    vi.stubGlobal('fetch', mockFetch(payload));

    render(<EvaluationPage />);

    await waitFor(() => expect(screen.getByText('Trajectory case (median)')).toBeInTheDocument());
    expect(screen.getByText(/versus a full deterministic trajectory case/)).toBeInTheDocument();
    expect(screen.getByText('1200 ms')).toBeInTheDocument();
    // The model with no recorded trajectory-case duration still gets its
    // own row's cell, rendered as "Not measured" rather than hiding just
    // that one cell — only the whole column disappears when nobody has data.
    expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);
  });
});

type CostPayload = EvaluationResponse['evals']['cost'];

/** One (modelId, role) row for the per-model cost table. */
function costRow(modelId: string, role: 'target' | 'judge', opts: { tokens?: number; price?: number; priced?: boolean; recorded?: boolean } = {}): CostPayload['perModel'][number] {
  const recorded = opts.recorded ?? true;
  const priced = opts.priced ?? true;
  const tokens = opts.tokens ?? 1000;
  const price = opts.price ?? 0.1;
  return {
    modelId,
    role,
    inputTokens: recorded ? tokens : 0,
    outputTokens: recorded ? tokens : 0,
    callCount: recorded ? 5 : 0,
    pricePerMillionInputTokens: priced ? price : null,
    pricePerMillionOutputTokens: priced ? price : null,
    estimatedCostUsd: recorded && priced ? (tokens / 1_000_000) * price * 2 : priced ? 0 : null,
    usageComplete: recorded,
  };
}

/** User-requested (2026-11-20, amended): "hide cost until it is complete,
 * no partial sums" — the "Estimated cost" tile and table render only once
 * every group (target models, Sonnet, judges) actually recorded usage and
 * is priced; otherwise neither renders, and "Run cost is not shown" is
 * appended to Known limitations. */
describe('EvaluationPage (cost display: hidden until every group is measured)', () => {
  it('all recorded: the cost tile and table are shown, and no "cost not shown" limitation is added', async () => {
    const payload = basePayload();
    payload.evals.cost = {
      perModel: [
        costRow('openai/gpt-6-luna', 'target', { tokens: 1_000_000, price: 0.1 }),
        costRow('anthropic/claude-sonnet-5.5', 'target', { tokens: 1_000_000, price: 0.2 }),
        costRow('google/gemini-3.8-flash', 'judge', { tokens: 1_000_000, price: 0.05 }),
      ],
      totalEstimatedCostUsd: 0.7,
      totalLabel: 'target models + Sonnet + judges',
      mechanism: 'eval-only-price-table',
      groups: {
        targetModels: { estimatedCostUsd: 0.2, allPriced: true, allRecorded: true, status: 'measured' },
        sonnet: { estimatedCostUsd: 0.4, allPriced: true, allRecorded: true, status: 'measured' },
        judges: { estimatedCostUsd: 0.1, allPriced: true, allRecorded: true, status: 'measured' },
      },
    };
    vi.stubGlobal('fetch', mockFetch(payload));

    render(<EvaluationPage />);

    await waitFor(() => expect(screen.getAllByText('Estimated cost').length).toBeGreaterThan(0));
    expect(screen.getAllByText('target models + Sonnet + judges').length).toBeGreaterThan(0);
    expect(screen.getByText('Total (target models + Sonnet + judges): $0.7000', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/Run cost is not shown/)).not.toBeInTheDocument();
  });

  it('judges missing: neither the cost tile nor the cost table render, and the "Run cost is not shown" limitation line appears', async () => {
    const payload = basePayload();
    // User-requested (2026-11-20, amended): "when you remove the estimated
    // cost, you should also remove what was related to it" — a
    // server-generated cost-related limitation (which would otherwise
    // dangle, e.g. pointing at "the cost groups above" once that section
    // no longer renders) must be dropped from the rendered list, replaced
    // by the page's own single "Run cost is not shown" line.
    payload.evals.limitations = [
      { id: 'story-7-4-pending', summary: 'pending' },
      { id: 'judge-call-cost-excluded', summary: 'The "Estimated cost" total covers target models + Sonnet; judges not recorded — see the cost groups above.' },
    ];
    payload.evals.cost = {
      perModel: [
        costRow('openai/gpt-6-luna', 'target', { tokens: 1_000_000, price: 0.1 }),
        costRow('anthropic/claude-sonnet-5.5', 'target', { tokens: 1_000_000, price: 0.2 }),
        costRow('google/gemini-3.8-flash', 'judge', { recorded: false }),
        costRow('deepseek/deepseek-v4.1-flash', 'judge', { recorded: false }),
      ],
      totalEstimatedCostUsd: 0.6,
      totalLabel: 'target models + Sonnet; judges not recorded',
      mechanism: 'eval-only-price-table',
      groups: {
        targetModels: { estimatedCostUsd: 0.2, allPriced: true, allRecorded: true, status: 'measured' },
        sonnet: { estimatedCostUsd: 0.4, allPriced: true, allRecorded: true, status: 'measured' },
        judges: { estimatedCostUsd: null, allPriced: true, allRecorded: false, status: 'not-recorded' },
      },
    };
    vi.stubGlobal('fetch', mockFetch(payload));

    render(<EvaluationPage />);

    await waitFor(() => expect(screen.getByText('Run cost is not shown: judge-model usage was not recorded in this run.')).toBeInTheDocument());
    expect(screen.queryByText('Estimated cost')).not.toBeInTheDocument();
    expect(screen.queryByText(/target models \+ Sonnet; judges not recorded/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0\.6000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/see the cost groups above/)).not.toBeInTheDocument();
  });
});

/** Story 7.5/7.2: the "Tools" section — both tables parsed server-side
 * from `docs/TECHNICAL-RATIONALE.md`, rendered with real row data. */
describe('EvaluationPage (Story 7.5/7.2: Tools section)', () => {
  it('renders both tool tables with their real row data', async () => {
    const payload = basePayload();
    payload.evals.perModelAccuracy = [{ modelId: 'openai/gpt-6-luna', deterministicCaseCount: 10, passedCaseCount: 9, accuracy: 0.9, meetsTarget: true }];
    payload.tools = {
      agentTools: [{ whereUserIs: 'Intake and idea discovery (chat)', agentThread: 'discovery agent (`discovery:<user>`)', toolsModelCanCall: '`submit_intake`, `generate_ideas`' }],
      toolDetails: [
        { tool: '`generate_ideas`', kind: 'LLM-backed', whoCallsIt: 'Model', whereInFlow: 'Ideas', whatItDoes: 'Generates a batch of side-income ideas.', writesState: 'Yes — `ideas`' },
        { tool: '`activate_plan`', kind: "Plain-code (own `StateGraph`)", whoCallsIt: 'UI only', whereInFlow: 'Plan draft → active plan', whatItDoes: 'Reviews and activates a draft plan.', writesState: 'Yes — `plans`, `plan_steps`' },
      ],
    };
    vi.stubGlobal('fetch', mockFetch(payload));

    render(<EvaluationPage />);

    await waitFor(() => expect(screen.getByText('Which tools each agent can call')).toBeInTheDocument());
    expect(screen.getByText('Intake and idea discovery (chat)')).toBeInTheDocument();
    expect(screen.getByText('What each tool does')).toBeInTheDocument();
    expect(screen.getByText('`generate_ideas`')).toBeInTheDocument();
    expect(screen.getByText('`activate_plan`')).toBeInTheDocument();
    expect(screen.getByText('Yes — `plans`, `plan_steps`')).toBeInTheDocument();
  });

  it('renders the "One chat turn" diagram as an accessible image with its name, plus the caption', async () => {
    vi.stubGlobal('fetch', mockFetch(basePayload()));

    render(<EvaluationPage />);

    await waitFor(() => expect(screen.getByRole('img', { name: 'One chat turn (middleware lifecycle)' })).toBeInTheDocument());
    expect(
      screen.getByText('What the guardrail tests cover: input moderation before the model, tool calls, output checks before the reply.'),
    ).toBeInTheDocument();
  });
});
