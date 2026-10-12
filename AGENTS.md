# AGENTS.md

Guidance for AI coding assistants (Codex, Claude Code, etc.) working in this repository.

- Stack: Node.js 24, TypeScript (ESM), official Feishu Channel SDK, pinned `@openai/codex` 0.153.4 App Server over STDIO.
- After changes run `npm test` and `npm run build`. Add tests for new behaviour; for bugs, add a failing test first.
- Never weaken permission checks, sandbox limits or credential separation to make tests pass.
- Never commit credentials, `.env`, real `config.json`/`runner.json`, chat transcripts, member IDs or anything under `data/`.
- `src/protocol/` is generated (`npm run protocol:generate`); do not edit by hand.
- User-facing bot text is Simplified Chinese; match surrounding code style and comment density.
- Report simulated tests, real-model runs, real-Feishu runs and human acceptance separately.
- Key modules: `src/router.ts` (intent routing & permissions), `src/group.ts` (group agent), `src/intent.ts` (Bridge intent model),
  `src/jobs.ts` (queue & delivery), `src/runner/*` (Bridge API, registry, node daemon), `src/sandbox.ts` + `src/codex.ts` (execution),
  `src/feishu.ts` (cards & delivery), `src/progress.ts` (live checklist).
