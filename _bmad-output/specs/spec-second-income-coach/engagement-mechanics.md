# Engagement Mechanics

Reference detail backing CAP-3/CAP-4/CAP-5: where each mechanic comes from and why, and the failure-pattern → plan-adaptation mapping. Load-bearing for whoever implements the plan and check-in logic; too granular for the SPEC kernel.

## Competitive landscape (why CAP-2 alone isn't the differentiator)

- Duolingo already owns fixed-curriculum vocabulary drilling — informed the decision (in the parked language-companion idea) that "study your own vocabulary" would be the only real differentiator there, and by analogy here: a tailored-idea quiz alone is not novel.
- Existing side-hustle-idea quiz tools (e.g. Side Hustle Quiz, SideHustlr.ai) already do a skills/time/budget/risk quiz → matched ideas + a personalized roadmap. One of them (Side Hustle Quiz) even ships a separate "Prediction Quiz" projecting 6-month income from habits/consistency, and a "Diagnostic Quiz" that identifies a one-time bottleneck.
- Conclusion driving CAP-4/CAP-5: the real differentiator is not idea generation (CAP-2, already commoditized) but an ongoing, adaptive accountability relationship (CAP-4) paired with a *live*, progress-driven projection (CAP-5) rather than a one-time static quiz guess.

## Borrowed mechanics, de-gamified

- **Finch** — "gentle return": missing a check-in is framed as a pause, not a failure, with zero negative feedback. Also celebrates the *start* of an action, not only its finish (the pet visibly reacts the moment an action begins). Adopted into CAP-4 as: neutral re-entry after a miss, and a distinct start-of-action acknowledgment separate from the completion acknowledgment. The pet/game skin itself is explicitly not adopted (see SPEC.md constraints/non-goals).
- **Fabulous** — progressive "Journey" structure: introduces one tiny habit at a time, gated on consistency rather than time (e.g. 3 days of one action before the next unlocks), explaining why the new piece matters when it unlocks. Grounded in BJ Fogg's B=MAP model (Motivation, Ability, Prompt) and the finding that the emotional high at the moment of completion — not repetition — wires in the habit. Adopted into CAP-3 as progressive step-unlocking with a why-it-matters explanation at each unlock.
- **Habitica** (RPG/gamification, social accountability) — considered and explicitly declined; see SPEC.md constraints (no gamified visual layer).
- Self-determination theory: autonomous motivation sustains behavior change better than guilt/control-based motivation — the underlying justification for the no-streak-shaming constraint.

## Income/opportunity projection calculation (CAP-5)

- **Income estimate:** baseline earning rate for the selected income-idea type (researched once at idea-generation time) × hours actually logged via check-ins, extrapolated forward at the user's real check-in completion-consistency rate (e.g. completed 80% of planned steps so far → forward projection scaled accordingly). Not a live market-data integration.
- **Unlocked opportunity:** a static, pre-written description attached to each plan step at generation time (e.g. "finishing this step means you have a sellable first product/portfolio piece") — not computed live.

## Failure-pattern → plan adaptation (CAP-3)

| Classified failure pattern (from CAP-1 intake) | Plan adaptation |
|---|---|
| Overwhelm | Smaller, more granular milestones; progressive step-unlocking (only current + next step visible) |
| Gets stuck with no clear next step | Next 2–3 steps always pre-staged internally, never just the current one |
| Loses interest once it becomes routine | Deliberate variety built into the plan |
| Forgets / deprioritizes | Lighter, more frequent check-ins |
| Life disruption | Automatic timeline adjustment on missed check-ins (CAP-4), neutral re-entry framing |
