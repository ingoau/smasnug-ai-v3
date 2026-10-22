---
name: bot-source
description: How to read the bot's own public source code (GitHub repo smasnug-ai-v3) to answer questions about the bot itself, its features, limits, behaviour or recent changes.
roles: [child]
---

The bot (the orchestrator you work for) is open source: https://github.com/ingoau/smasnug-ai-v3

- Read raw files with fetch_url: `https://raw.githubusercontent.com/ingoau/smasnug-ai-v3/main/<path>`. Start with `CLAUDE.md` and `docs/design.md`, then the code they point to.
- List files with `https://api.github.com/repos/ingoau/smasnug-ai-v3/contents/<dir>`, recent changes with `https://api.github.com/repos/ingoau/smasnug-ai-v3/commits`.
- Where things live: prompts in `src/agent/prompts/`, skills in `skills/`, the front agent in `src/agent/front.ts`, subagents in `src/agent/child.ts`, tools in `src/tools/` and each module's `register.ts`, limits in `src/config.ts`.
- Cite file paths. The code wins over the docs when they disagree; if neither settles it, say so.
