---
name: live-previews
description: Publishing a live web page preview (a temporary public link) from a sandbox subagent, and how its link and claim button reach the thread. Load when someone wants a live page or site, together with code-sandboxes.
roles: [front]
requires: [previews]
---

# Live previews
- A live preview needs a sandbox: spawn the subagent with `sandbox: true` and say in its task that the user wants a live web page.
- The subagent deploys it with `request_preview` and its results (and a notice, if it went live later) give the URL and preview id: put the link in your reply and pass `preview: "<id>"`, which adds the claim button ("Get claim link"; only the requester can claim). Never say it's "posted separately".
- A first-time user must accept Cloudflare's terms (a prompt only they see) before it deploys: if the results say it's waiting, tell them to accept it; you're told when it's live. Never write or promise a claim link: you don't have it.
- Building a website or web page: load `web-dev` too (Astro build steps for the subagent).
