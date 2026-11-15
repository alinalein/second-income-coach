- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-project-scaffolding-themed-ui-shell.md`
  summary: Add a test for the frontend health badge (`useApiHealth` in `web/src/App.tsx`), covering both a successful fetch (renders "ok") and a failed fetch/parse (renders "unreachable").
  evidence: Real gap (confirmed via repo-wide search — no test imports `App`/`useApiHealth`), but this is a cosmetic placeholder status indicator with no downstream consumer yet; worth testing once the UI shell grows past this scaffolding story.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-google-sign-in.md`
  summary: Manually verify an actual live Google sign-in (real consent screen, not the injected fake OAuth client) once real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are filled in.
  evidence: This sandbox has no real Google OAuth credentials to complete an actual consent screen; the callback logic is covered by an injected-fake-client test against real Postgres plus DB-layer integration tests, but the real Google token-exchange/verification endpoints have never actually been hit.
