---
name: web-dev
description: Building websites (a site, landing page, portfolio, web page, web app front end, "make me a website"): built with Astro in a code sandbox and published as a live Cloudflare preview. Load whenever the user asks to build, make or redesign a website or web page.
roles: [front, child]
requires: [previews]
---

# Web dev: Astro in a sandbox, live Cloudflare preview

## Front agent (in the thread)
- Every website build goes to a subagent with `sandbox: true`, never create_file. Even a one-page site.
- In its task: what the user wants (content, pages, style, any text or files they gave; pass the file_… ids), that it
  is a website build, that it must load the `web-dev` skill first, and that the user wants a live preview.
- Tell the user in one line that you're building it and you'll post the link when it's done.
- The results give the live preview's URL and id: put the link in your reply and pass `preview: "<id>"` (adds the
  claim button). If it's waiting for the user to accept Cloudflare's terms, say the link comes once they accept (you're
  told when it's live). Never invent a URL or a claim link.
- Changes to a site you built go to the same subagent as a follow-up (its sandbox still has the project), which
  deploys a new preview.
- Previews are static only: no backend, database, logins, password or payment forms. If the user wants those, say so
  and build the static part (forms can post to a third-party service like Formspree, or be mocked).

## Subagent (in the sandbox)
Always Astro, always in the sandbox, always finished with `request_preview`.

1. **Create** (skip if `/work/site` already exists from an earlier run; edit it instead):
   `cd /work && pnpm create astro@latest site --template minimal --install --no-git --skip-houston --yes` (timeout_s 180).
   Add integrations only when they're needed, e.g. `pnpm astro add tailwind --yes`, `pnpm astro add mdx --yes`.
2. **Build the pages**: `src/pages/*.astro` (one file per route), shared layout in `src/layouts/`, components in
   `src/components/`, static files in `public/`. Write files with `sandbox_write_file`.
   - Static output only: no `output: 'server'`, no adapter, no API routes or server endpoints.
   - Make it look designed, not like a template: a deliberate palette and type pairing, real copy (no lorem ipsum),
     responsive down to phone width, semantic HTML, alt text, good contrast.
   - Keep it light: no huge images (resize with pillow if the user's are big), no heavy JS. Use Astro islands only for
     interactivity that needs them.
   - No login, password or payment forms: the preview is refused if it has them.
3. **Build**: `cd /work/site && pnpm build` → `dist/` with `index.html` at its top. Fix every error and rebuild.
4. **Check it**: no background servers survive a command, so serve and screenshot in one command, e.g.
   `cd /work && python3 -m http.server 4321 -d site/dist >/dev/null 2>&1 & srv=$!; sleep 1; node /work/shot.cjs; kill $srv`
   with a CommonJS Playwright script (`require('playwright')`; the global install isn't visible to ESM imports) that screenshots each page at desktop (1280 wide) and phone (390 wide) widths, full page.
   Look at the PNGs with `sandbox_read_file` and fix what looks wrong (overflow, broken images, unreadable text).
5. **Publish**: `request_preview` with `dir: "/work/site/dist"` and a short title. It deploys and returns the URL and a
   preview id (or says it's waiting for the user to accept Cloudflare's terms). Fetch the URL to check it renders; if
   it's broken, fix, rebuild and call it again (each deploy counts toward the daily limit). Limits: ≤ 1,000 files,
   ≤ 5 MiB each, ≤ 25 MiB total. If it's refused (limits, turned off), say why and export instead.
6. **Source**: zip the project without `node_modules`/`dist`
   (`cd /work && zip -qr site.zip site -x 'site/node_modules/*' 'site/dist/*' 'site/.astro/*'`) and `sandbox_export` it so
   the user can keep it.
7. **Result**: what you built (pages, notable choices), the preview URL and preview id from `request_preview` (it lasts
   60 minutes unless claimed; or that it's waiting for the terms), and the source zip. Never invent a URL.
