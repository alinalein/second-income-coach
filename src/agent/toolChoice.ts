import { createMiddleware } from 'langchain';

/**
 * Perf fix (user-requested, Story 3.1 follow-up): a trigger invocation that
 * already knows exactly which tool must run (e.g. `create_plan`'s lazy
 * create-or-fetch trigger) shouldn't pay for a full "which tool should I
 * call" reasoning round-trip. `runtime.configurable.forceToolChoice` — set
 * only by that one trusted server-side call site (`src/api/routes/
 * plans.ts`), never model-supplied — forces the model's `tool_choice` to
 * exactly that function.
 *
 * A no-op for every other caller (discovery chat, the `submit_intake`/
 * `generate_ideas` triggers, plan-thread free-form follow-ups), which never
 * set this flag: `toolChoice` is left untouched (whatever the model's own
 * default — `'auto'` — already was), so this middleware is safe to wire into
 * every compiled agent unconditionally.
 */
export function createForceToolChoiceMiddleware() {
  return createMiddleware({
    name: 'ForceToolChoiceMiddleware',
    wrapModelCall: (request, handler) => {
      const forced = (request.runtime.configurable as { forceToolChoice?: string } | undefined)?.forceToolChoice;
      if (!forced) return handler(request);
      return handler({ ...request, toolChoice: { type: 'function', function: { name: forced } } });
    },
  });
}
