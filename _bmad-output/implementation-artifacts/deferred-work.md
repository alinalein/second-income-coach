- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-project-scaffolding-themed-ui-shell.md`
  summary: Add a test for the frontend health badge (`useApiHealth` in `web/src/App.tsx`), covering both a successful fetch (renders "ok") and a failed fetch/parse (renders "unreachable").
  evidence: Real gap (confirmed via repo-wide search — no test imports `App`/`useApiHealth`), but this is a cosmetic placeholder status indicator with no downstream consumer yet; worth testing once the UI shell grows past this scaffolding story.
