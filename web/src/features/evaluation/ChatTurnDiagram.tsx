/**
 * User-requested (2026-11-20): "One chat turn (middleware lifecycle)" —
 * the same Mermaid flowchart in `ARCHITECTURE-SPINE.md` (not edited; this
 * is a hand-drawn equivalent, `@mermaid-js/mermaid-cli`'s own output embeds
 * ~300KB of hardcoded-color CSS with no dark-mode story, and the task is
 * explicit: no new dependency, no runtime Mermaid renderer). Inline JSX
 * (not a `public/`-served `<img>`) so `currentColor` genuinely tracks the
 * app's own `.dark` class — an `<img>`-loaded SVG is a separate document;
 * `currentColor` inside one never sees the host page's theme at all. The
 * identical markup is also committed at `web/public/chat-turn.svg` (the
 * source of truth this component mirrors) for anyone who wants the
 * standalone file.
 */
export function ChatTurnDiagram() {
  return (
    <svg
      viewBox="0 0 780 1100"
      width="100%"
      role="img"
      aria-label="One chat turn (middleware lifecycle)"
      aria-describedby="chat-turn-desc"
      className="h-auto w-full"
    >
      <title id="chat-turn-title">One chat turn (middleware lifecycle)</title>
      <desc id="chat-turn-desc">
        Flowchart: a user message enters the outer model node, passes through progress and Mistral moderation middleware
        before the model call, then through output moderation and guilt-language middleware, which either runs a tool
        (looping back to progress middleware) or saves the reply to the checkpoint. A rejected input skips straight to a
        fixed refusal reply.
      </desc>
      <defs>
        <marker id="chat-turn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth="1.5" fontFamily="inherit">
        <path d="M 175,55 L 175,80" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,150 L 175,175" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,245 L 175,270" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,350 L 175,375" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,445 L 175,470" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,540 L 175,565" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,635 L 175,660" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,730 L 175,755" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,835 L 175,860" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 175,955 L 175,980" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 330,310 L 460,310" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 660,330 L 740,330 L 740,1005 L 290,1005" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 330,900 L 460,900" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 560,940 L 560,965" markerEnd="url(#chat-turn-arrow)" />
        <path d="M 660,1005 L 700,1005 L 700,210 L 330,210" markerEnd="url(#chat-turn-arrow)" />
      </g>
      <g fontFamily="inherit" fontSize="13" stroke="currentColor" strokeWidth="1.5" fill="none">
        <rect x="80" y="20" width="190" height="36" rx="18" />
        <rect x="50" y="80" width="250" height="70" rx="8" />
        <rect x="50" y="175" width="250" height="70" rx="8" />
        <rect x="50" y="270" width="250" height="80" rx="8" />
        <rect x="460" y="270" width="200" height="80" rx="8" />
        <rect x="50" y="375" width="250" height="70" rx="8" />
        <rect x="50" y="470" width="250" height="70" rx="8" />
        <rect x="50" y="565" width="250" height="70" rx="8" />
        <rect x="50" y="660" width="250" height="70" rx="8" />
        <rect x="50" y="755" width="250" height="80" rx="8" />
        <rect x="50" y="860" width="250" height="80" rx="8" />
        <rect x="460" y="860" width="200" height="60" rx="8" />
        <rect x="460" y="965" width="200" height="80" rx="8" />
        <rect x="70" y="980" width="220" height="50" rx="25" />
      </g>
      <g fontFamily="inherit" fontSize="13" fill="currentColor" textAnchor="middle">
        <text x="175" y="43">User message</text>

        <text x="175" y="105">1 Outer node</text>
        <text x="175" y="122">model</text>
        <text x="175" y="139">loads settings</text>

        <text x="175" y="200">2a Progress</text>
        <text x="175" y="217">Middleware</text>
        <text x="175" y="234">progress event</text>

        <text x="175" y="290">2b Mistral</text>
        <text x="175" y="307">Moderation</text>
        <text x="175" y="324">Middleware</text>
        <text x="175" y="341">checks input</text>

        <text x="560" y="290">Fixed refusal</text>
        <text x="560" y="307">text, model</text>
        <text x="560" y="324">never sees it</text>

        <text x="175" y="395">3a dynamic</text>
        <text x="175" y="412">SystemPrompt</text>
        <text x="175" y="429">prompt, memories</text>

        <text x="175" y="490">3b ForceTool</text>
        <text x="175" y="507">Choice</text>
        <text x="175" y="524">Middleware</text>

        <text x="175" y="585">3c Model</text>
        <text x="175" y="602">Selection</text>
        <text x="175" y="619">Middleware</text>

        <text x="175" y="680">4 Model call</text>
        <text x="175" y="697">answer or</text>
        <text x="175" y="714">tool call</text>

        <text x="175" y="775">5a Mistral</text>
        <text x="175" y="792">Moderation</text>
        <text x="175" y="809">Middleware</text>
        <text x="175" y="826">checks output</text>

        <text x="175" y="880">5b Guilt</text>
        <text x="175" y="897">Language</text>
        <text x="175" y="914">Middleware</text>
        <text x="175" y="931">plan chat only</text>

        <text x="560" y="885">6 Progress</text>
        <text x="560" y="902">Middleware</text>
        <text x="560" y="919">tool label</text>

        <text x="560" y="985">7 Tool runs</text>
        <text x="560" y="1002">plain-code tool,</text>
        <text x="560" y="1019">generate_ideas</text>
        <text x="560" y="1036">or create_plan</text>

        <text x="180" y="1000">Reply saved</text>
        <text x="180" y="1017">to checkpoint</text>
      </g>
      <g fontFamily="inherit" fontSize="12" fill="currentColor" textAnchor="middle">
        <text x="395" y="302">rejected</text>
        <text x="220" y="366">ok</text>
        <text x="395" y="892">tool call</text>
        <text x="220" y="971">answer</text>
      </g>
    </svg>
  );
}
