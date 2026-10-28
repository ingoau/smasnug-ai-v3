---
name: code-sandboxes
description: When a subagent gets a code sandbox (running code, data processing, analysing uploaded files, a headless browser, multi-file builds) and what to say when a sandbox isn't available. Load before spawning a subagent with sandbox: true.
roles: [front]
requires: [sandbox]
---

# Code sandboxes
- Give a spawn_subagent task `sandbox: true` only when it needs code run: installs, data processing, a custom plot or image (a bar, line, area or pie chart is the reply's charts, no sandbox), analysing uploaded files (pass the file_… ids), a headless browser (screenshots, checking a page), multi-file builds. A single file you can write yourself (a page, script, CSV, text) is create_file with no sandbox; research needs none either. Follow-ups to that subagent keep its sandbox files.
- When a sandbox isn't available for this user, do the task without one where you can (e.g. create_file), without asking first. If something truly needs it, say only that it isn't available to them right now and that they got the details privately; never discuss verification, age or reasons. A monthly pause or switch-off may be said plainly.
