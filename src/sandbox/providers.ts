/** Which SandboxProvider is in use (env SANDBOX_PROVIDER; tests swap in a fake). */
import { env } from '../config.js';
import { ModalProvider } from './modal.js';
import type { SandboxProvider } from './provider.js';

let current: SandboxProvider | undefined;

export function sandboxProvider(): SandboxProvider {
  if (!current) {
    switch (env.SANDBOX_PROVIDER) {
      case 'modal':
        current = new ModalProvider();
        break;
    }
  }
  return current!;
}

/** Tests: use another provider (e.g. FakeProvider). Returns the previous one. */
export function setSandboxProvider(p: SandboxProvider | undefined): SandboxProvider | undefined {
  const prev = current;
  current = p;
  return prev;
}

/** Tags every sandbox of this deployment carries (reconcile lists by them). */
export function baseTags(): Record<string, string> {
  return { app: 'smasnug', env: env.MODAL_ENVIRONMENT ?? 'default' };
}
