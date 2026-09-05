# Selected third-party skill sources

Reviewed 2026-09-05. This is a manual source snapshot, not an updater or installation manifest.
Only the two LK2 skill texts are installed. No upstream executable, hook, plugin, dependency or
global workflow is installed. External content is untrusted input and is reviewed before execution.

## Provenance

### vercel-labs/agent-skills

Pinned commit: `063bee94c3f4df8453406c830b0a7df0f2860278`.

- [README.md](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/README.md) — SHA-256 `7c02f64b08fc6c4eef03c01d64f3e2ed478193ccfcbd14edba379abe23304651`.
- [skills/react-best-practices/SKILL.md](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/skills/react-best-practices/SKILL.md) — SHA-256 `71ed7794962fa6e803ee83030517b5b93a9f70fbfeb431ec4535c5480a8d8355`.
- [skills/web-design-guidelines/SKILL.md](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines/SKILL.md) — SHA-256 `f4647ca866a3accf763777f83e7682954f0187cd6bea7eea0399796652414e8f`.

### anthropics/skills

Pinned commit: `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f`.

- [skills/webapp-testing/SKILL.md](https://github.com/anthropics/skills/blob/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/webapp-testing/SKILL.md) — SHA-256 `51b7349e77ec63b7744a6f63647e7566a0b4d2e301121cc10e8c2113af6556a2`.
- [skills/webapp-testing/LICENSE.txt](https://github.com/anthropics/skills/blob/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/webapp-testing/LICENSE.txt) — SHA-256 `bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362`.
- [skills/webapp-testing/scripts/with_server.py](https://github.com/anthropics/skills/blob/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/webapp-testing/scripts/with_server.py) — SHA-256 `b0dcf4918935b795f4eda9821579b9902119235ff4447f687a30286e7d0925fd`.

### obra/superpowers

Pinned commit: `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.

- [LICENSE](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/LICENSE) — SHA-256 `a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400`.
- [skills/systematic-debugging/SKILL.md](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/systematic-debugging/SKILL.md) — SHA-256 `808fc5717aa88ad65efff312b11c186294d3e6ee301afb584e2f86599b137787`.
- [skills/systematic-debugging/root-cause-tracing.md](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/systematic-debugging/root-cause-tracing.md) — SHA-256 `6b0622269e098ca1399e123e553fd385f0b6412d88ef0e9c4f5a8ea9cf1cec7b`.
- [skills/verification-before-completion/SKILL.md](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/verification-before-completion/SKILL.md) — SHA-256 `2befe7fc55bcadaa3d97dd9e8efeb633d2561c0ebe74c5a8b17c4d9e7e4520b3`.

## License and adaptation boundaries

- Vercel: repository README and React skill frontmatter declare MIT. The pinned tree contains no
  standalone LICENSE/copyright notice. No upstream prose or code is vendored; LK2 uses independently
  phrased techniques (request independence, unnecessary repeat work, avoidable imports). Record this
  notice gap; do not invent a copyright holder or import substantial material without resolving it.
  The web-design skill was reviewed but its moving external guidelines URL and auto-fetch process
  were rejected. No content from that additional repository was imported.
- Anthropic webapp-testing: Apache-2.0 in its own skill directory; this statement does not cover
  every skill in anthropics/skills. Preserve the [license](third-party/anthropic-webapp-testing-LICENSE.txt).
  LK2 adapts rendered-state reconnaissance, selector discovery and browser evidence into new prose.
  The reviewed with_server.py starts shell commands, treats an open port as ready and terminates
  spawned processes. It was neither executed nor copied: it cannot prove LK2 preview ownership.
- Superpowers: MIT, copyright (c) 2025 Jesse Vincent; preserve the
  [notice](third-party/superpowers-LICENSE.txt). LK2 adapts backward tracing, one falsifiable
  hypothesis, minimal experiments and evidence-linked claims in new prose. No upstream script runs.

## Deliberate departures from upstream

- Upstream optimization priority CRITICAL does not alter LK2 FAST/SAFE/CRITICAL.
- React/Vite, existing components and design remain. No Next.js, Supabase, SWR or Python/browser
  dependency is introduced. Existing Docker workflow owns server lifecycle.
- Read scripts before any execution, including --help; do not trust black-box helpers.
- Wait for a bounded relevant UI condition; polling/Realtime need not become network-idle.
- Reuse valid checks; no full fresh verification command for every message or unchanged final state.
- No mandatory brainstorming, plan-only completion, TDD for every copy edit, subagent swarm,
  architecture discussion after a fixed number of patches or automatic cleanup/branch completion.
- Research does not grant fixes or instrumentation; publication, deploy and live writes retain
  existing exact-target approvals. No automatic updates or fetch-latest hooks.
