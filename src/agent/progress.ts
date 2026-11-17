import { createMiddleware, type ToolCallHandler, type ToolCallRequest } from 'langchain';

/**
 * Story 1.5 Code Map: the fixed step-to-label registry (AD-31). Every key
 * here is a localization key under `web/src/locales/{en,de}/chat.json`'s
 * `progress` namespace (AC3) — the client never renders a raw internal
 * hook/tool name, only one of these fixed strings.
 */
export const CHECKING_MESSAGE = 'checking_message';
export const GENERATING_RESPONSE = 'generating_response';
export const CHECKING_ANSWER = 'checking_answer';
export const TOOL_FALLBACK = 'tool_fallback';

/**
 * AD-31: "each tool-introducing story registers its own label key, same
 * pattern as the env-variable rule" — `wrapToolCall` below is wired so each
 * tool-introducing story only adds a registry entry + an i18n key, not new
 * middleware plumbing (Design Notes). Story 3.1 (Code Map: "Story 3.1
 * registers 'Working on your plan…' for `create_plan`") is the first entry;
 * `get_current_step` stays unmapped (falls back to `TOOL_FALLBACK`) — same
 * as `web_search`/`generate_ideas`'s own still-open gap (spec Design Notes:
 * "pre-existing gaps noticed, not fixed here").
 */
export const TOOL_STEP_REGISTRY: ReadonlyMap<string, string> = new Map([['create_plan', 'creating_plan']]);

/**
 * AC2: "the tool's own registered label, or the fixed generic fallback if
 * unmapped — never blank, never the raw tool name."
 */
export function resolveToolStepKey(toolName: string): string {
  return TOOL_STEP_REGISTRY.get(toolName) ?? TOOL_FALLBACK;
}

type ProgressWriter = ((chunk: unknown) => void) | undefined;

function writeProgress(writer: ProgressWriter, step: string): void {
  writer?.({ type: 'progress', step });
}

/**
 * AD-19 (amended), AC1: emits one `{ type: 'progress', step }` custom-stream
 * chunk at each real agent-loop boundary, then passes the turn through
 * unchanged — this middleware never alters model/tool behavior, only
 * observes it. Registered *first* in `createCoachAgent`'s `middleware` array
 * (Design Notes) so `beforeModel` always fires, even when the moderation
 * middleware's own `beforeModel` short-circuits with `jumpTo: 'end'` on a
 * jailbreak reject — this is what makes the jailbreak I/O-matrix row ("only
 * `checking_message`, no `generating_response`/`checking_answer`") correct
 * rather than accidental.
 */
export function createProgressMiddleware() {
  return createMiddleware({
    name: 'ProgressMiddleware',
    beforeModel: (_state, runtime) => {
      writeProgress(runtime.writer, CHECKING_MESSAGE);
    },
    wrapModelCall: async (request, handler) => {
      writeProgress(request.runtime.writer, GENERATING_RESPONSE);
      // Measurement (user-requested): how long the model-decide call itself
      // takes — with a forced `tool_choice` (`toolChoice.ts`) this should be
      // the cheap "dispatch to the named tool" call, not a real reasoning one.
      const start = Date.now();
      const result = await handler(request);
      console.log('[agent] model_call', { elapsedMs: Date.now() - start });
      return result;
    },
    // Unreachable until a tool exists (no tool is registered in this story —
    // Boundary: "no new tool in this story"), but wired now per AD-31 so a
    // later tool-introducing story only adds a registry entry + i18n key.
    wrapToolCall: async (request: ToolCallRequest, handler: ToolCallHandler) => {
      // `request.tool` is typed `ClientTool | ServerTool | undefined`, and
      // `ServerTool` is a bare `Record<string, unknown>` — `.name` isn't
      // statically known to be a string on that branch, so it's coerced
      // defensively; `request.toolCall.name` (the actual invoked name) is
      // always a string and is the fallback/primary source either way.
      const toolName = String(request.tool?.name ?? request.toolCall.name);
      writeProgress(request.runtime.writer, resolveToolStepKey(toolName));
      // Measurement (user-requested): "the plan call" — how long the tool's
      // own execution (its real LLM-generation work, for an LLM-backed tool)
      // actually takes, isolated from the model-decide/moderation calls
      // around it.
      const start = Date.now();
      const result = await handler(request);
      console.log('[agent] tool_call', { tool: toolName, elapsedMs: Date.now() - start });
      return result;
    },
    afterModel: (_state, runtime) => {
      writeProgress(runtime.writer, CHECKING_ANSWER);
    },
  });
}
