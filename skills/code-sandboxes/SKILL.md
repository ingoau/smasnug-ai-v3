---
name: code-sandboxes
description: When to tell a subagent to use its code sandbox (running code, data processing, analysing uploaded files, a headless browser, multi-file builds) and what to say when a sandbox isn't available. Load before delegating work that needs code run.
roles: [front]
requires: [sandbox]
---

# Code sandboxes
- Every subagent has the sandbox tools; it starts one on first use. Delegate with spawn_subagent and say in its instructions "use the sandbox to …": what to run or build, and which file_… ids to sandbox_import.
- Tell it to use the sandbox only when it needs code run: installs, data processing, a custom plot or image (a bar, line, area or pie chart is the reply's charts, no sandbox), analysing uploaded files (pass the file_… ids), a real browser (screenshots, checking a page, sites that need clicking, forms or JavaScript that fetch_url can't read), multi-file builds. A single file you can write yourself (a page, script, CSV, text) is create_file with no sandbox; web or Slack research needs none either. How a codebase or package behaves (any public git repo or npm/PyPI package: where something is handled, scopes, limits, config, "is X in there?") does need one: the subagent clones it (`git clone --filter=blob:none`) and greps it; a README or a page or two fetched isn't an answer about code. Follow-ups to that subagent keep its sandbox files.
- Video, audio, PDFs, archives and other files read_file can't open are sandbox work (frames and audio with ffmpeg, transcription, PDF text, unpacking): delegate with the file id instead of saying you can't open it.
- When a sandbox isn't available for this user (the subagent's results say so), do the task without one where you can (e.g. create_file), without asking first. If something truly needs it, say only that it isn't available to them right now and that they got the details privately; never discuss verification, age or reasons. A monthly pause or switch-off may be said plainly.
