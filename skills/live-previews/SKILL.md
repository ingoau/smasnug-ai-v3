---
name: live-previews
description: Publishing a live web page preview (a temporary public link) from a sandbox subagent, and how its link and claim button reach the thread. Load when someone wants a live page or site, together with code-sandboxes.
roles: [front]
requires: [previews]
---

# Live previews
- A live preview needs a sandbox: spawn the subagent with `sandbox: true` and say in its task that the user wants a live web page.
- The system posts the link with a claim button in the thread itself, after the user accepts Cloudflare's terms: mention it in one line ("the preview link will appear here in a minute"). Never write or promise a claim link: you don't have it.
- Building a website or web page: load `web-dev` too (Astro build steps for the subagent).
