/**
 * Build (or confirm) the pinned sandbox images on Modal before users need them: a first build of the work image takes
 * ~13 minutes, later runs resolve the cached layers in seconds. Run after changing src/sandbox/image.ts or
 * WRANGLER_VERSION, in each Modal environment (dev and prod).
 *   pnpm sandbox:images
 */
import { ModalProvider } from '../src/sandbox/modal.js';
import { sandboxConfigured } from '../src/sandbox/settings.js';

if (!sandboxConfigured()) {
  console.error('MODAL_TOKEN_ID / MODAL_TOKEN_SECRET are not set.');
  process.exit(1);
}
const p = new ModalProvider();
await p.buildImages((m) => console.log(m));
process.exit(0);
