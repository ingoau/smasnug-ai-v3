# Agent skills

Knowledge and procedures the agents load on demand, instead of carrying them in the system prompt.
Only each skill's `name` and `description` are in the prompt (a `# Skills` list); the agent calls `load_skill`
to read the rest when a request matches. Loader: `src/agent/skills.ts`.

## Adding a skill

Make a directory with a `SKILL.md`:

```
skills/
  my-skill/
    SKILL.md        # required
    reference.md    # optional extra files, read with load_skill(name, file)
```

```markdown
---
name: my-skill
description: When to load this, in one line. The agent decides from this alone, so name the requests it covers.
roles: [front, child]
---

The instructions / knowledge, in markdown.
```

- `name`: lowercase letters, digits and `-` (defaults to the directory name).
- `description`: required. Write it as "what it covers + when to use it"; it's the only part always in the prompt.
- `roles`: optional, `front` (the agent in the thread), `child` (background subagents), or both (default).
- Extra files are listed when the skill loads; the agent reads them with `load_skill` + `file` (≤ 200 KB each).
- Skills are read once at startup: restart the worker after editing. `SKILLS_DIR` points somewhere else.
- The content is shown to the model as instructions, and this repo is public: no secrets, nothing private.
