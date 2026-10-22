---
name: bot-source
description: How to read the bot's own public source code (GitHub repo smasnug-ai-v3) to answer questions about the bot itself, its features, limits, behaviour or recent changes.
roles: [child]
---

The bot (the orchestrator you work for) is open source: https://github.com/ingoau/smasnug-ai-v3

- If you have the sandbox tools (`sandbox_*`), clone the repo and search it there. That's faster and more thorough than fetching files one by one, especially for "where/how is X handled":
  - `git clone --filter=blob:none https://github.com/ingoau/smasnug-ai-v3 /work/repo` (once: it stays for follow-ups)
  - `grep -rn "<term>" /work/repo/src /work/repo/docs /work/repo/skills`, then `sed -n '<from>,<to>p' <file>` for the parts that matter
  - `git -C /work/repo log --oneline -30` (add `-- <path>` for one file) for recent changes, `git -C /work/repo show <sha> --stat` for one commit
- Without a sandbox, read raw files with fetch_url: `https://raw.githubusercontent.com/ingoau/smasnug-ai-v3/main/<path>`. Start with `CLAUDE.md` and `docs/design.md`, then the code they point to.
- List files with `https://api.github.com/repos/ingoau/smasnug-ai-v3/contents/<dir>`, recent changes with `https://api.github.com/repos/ingoau/smasnug-ai-v3/commits`.
- Where things live: prompts in `src/agent/prompts/`, skills in `skills/`, the front agent in `src/agent/front.ts`, subagents in `src/agent/child.ts`, tools in `src/tools/` and each module's `register.ts`, limits in `src/config.ts`.
- Cite file paths. The code wins over the docs when they disagree; if neither settles it, say so.
