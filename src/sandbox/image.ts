/**
 * Sandbox images, pinned (docs/sandbox.md §3.3). Built by Modal from these layers (Modal caches every layer by its
 * content, so an unchanged definition resolves to the already-built image in about a second). Bumping a version is a
 * code change here; old snapshots keep working, because they are images of their own.
 *
 * Work image: Playwright's Ubuntu image (Node 22 + Chromium and its system deps), plus Python 3.12 with the usual
 * data libraries, pnpm, the Playwright packages for both languages (same browser build), and the unprivileged
 * `sandbox` user owning /work. Deploy image: Node 22 + a pinned wrangler, nothing else.
 */
import { env } from '../config.js';

export const PLAYWRIGHT_VERSION = '1.56.1';
/** The Python package matching PLAYWRIGHT_VERSION's browser build. */
export const PLAYWRIGHT_PY_VERSION = '1.56.0';

export interface ImageDef {
  /** Short name for logs and the `sandboxes.image` column. */
  name: string;
  registry: string;
  commands: string[];
}

const SANDBOX_USER = [
  // The Playwright base image ships an `ubuntu` user with uid 1000; replace it with ours.
  'RUN (id -u ubuntu >/dev/null 2>&1 && userdel -r ubuntu || true) && useradd -m -u 1000 -d /work -s /bin/bash sandbox && chown sandbox:sandbox /work',
];

export function workImage(): ImageDef {
  return {
    name: `work-pw${PLAYWRIGHT_VERSION}`,
    registry: `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble`,
    commands: [
      'ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
      'RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git jq sqlite3 zip unzip curl ca-certificates util-linux && rm -rf /var/lib/apt/lists/*',
      `RUN pip3 install --break-system-packages --no-cache-dir numpy pandas matplotlib pillow openpyxl requests beautifulsoup4 playwright==${PLAYWRIGHT_PY_VERSION}`,
      `RUN npm install -g pnpm@10 playwright@${PLAYWRIGHT_VERSION}`,
      // `require('playwright')` works from any directory.
      'ENV NODE_PATH=/usr/lib/node_modules',
      ...SANDBOX_USER,
    ],
  };
}

export function deployImage(): ImageDef {
  return {
    name: `deploy-wrangler${env.WRANGLER_VERSION}`,
    registry: 'node:22-bookworm-slim',
    commands: [
      'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux && rm -rf /var/lib/apt/lists/*',
      `RUN npm install -g wrangler@${env.WRANGLER_VERSION} && npm cache clean --force`,
      'RUN (id -u node >/dev/null 2>&1 && userdel -r node || true) && useradd -m -u 1000 -d /work -s /bin/bash sandbox && chown sandbox:sandbox /work',
    ],
  };
}
