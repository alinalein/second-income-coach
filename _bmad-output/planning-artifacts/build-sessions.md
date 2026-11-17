# Build session plan

Stories stay tracked one by one in `sprint-status.yaml`. A session builds one or more of them together so the codebase is read once. Updated 2026-11-17.

## Done (merged in main)
1.1-1.6, 2.1, 2.2, 2.3, 2.5, 2.7, 2.8, 3.1, 5.1, 5.4, 5.5, 6.2, 6.3. 6.1 is partial (see session 12).

## Running
| Session | Stories | Lane |
|---|---|---|
| 1 | 2.10 Direct paths | A |
| 2 | 2.11 Search budget guard | B |

## Next (each session = one /bmad-build prompt, one codebase read)
| Session | Stories | Why together | Starts after |
|---|---|---|---|
| 3 | 2.4 Generate more ideas (batch of 3, added) | generate_ideas + ideas route | 2.10, 2.11 |
| 4 | 3.2 Plan activation (interrupt, one active plan) | plan routes + agent graph | 2.10 |
| 5 | 2.9 + 3.3 Sidebar + plan switching | sidebar is the UI for switching | 3.2 |
| 6 | 4.1 + 4.2 Text check-in + missed check-in | same tools and time logic | 3.2 |
| 7 | 4.4 Projection | reads check-ins | session 6 |
| 8 | 4.3 Voice check-in | external service and keys, stays alone | session 6 |
| 9 | 5.2 + 5.3 Cost line + feedback | both are message-footer items | 2.10 |
| 10 | 7.1 + 7.2 + 7.4 Docs | same final state, one pass | all features |
| 11 | 7.5 Quality & Decisions page | reads the 6.3 report JSON | session 10, eval run |
| 12 | 6.1 completion + eval fixtures for plan/check-in tools | plain fixture files, then the user runs `npm run eval` and `npm run eval:report` | sessions 4-8 |

Optional, always last: 2.6 faster generation, 7.3 deploy.

## Parallel plan
After 2.10 and 2.11: A = session 3, B = session 4, C = session 9. Then 5, 6, 7 / 8, then 10, 11, 12.

## Rules for every session prompt
Name the files to read and say "no other exploration". No design/UX skill. One review pass. Fix defects until the ACs work. Report the tokens used.
