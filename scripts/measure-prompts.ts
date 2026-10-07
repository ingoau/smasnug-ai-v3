/**
 * Dumps the front / child system prompts and tool definitions (name + description + JSON schema, as the provider
 * sees them) to a directory, for token counting. Usage: tsx scripts/measure-prompts.ts <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
process.env.OPENROUTER_KEY ||= 'x';
process.env.SLACK_FAKE = '1';
process.env.LOG_LEVEL = 'silent';
// Every optional feature on, so all prompt sections and tools are counted.
process.env.HUDDLEFM_USER_ID ||= 'UHUDDLEFM';
process.env.MODAL_TOKEN_ID ||= 'x';
process.env.MODAL_TOKEN_SECRET ||= 'x';
process.env.PREVIEW_SECRET_KEY ||= Buffer.alloc(32).toString('base64');
process.env.CURSOR_API_KEY ||= 'x';
process.env.CURSOR_REPO ||= 'https://github.com/example/repo';
const out = process.argv[2] ?? 'prompt-dump';
mkdirSync(out, { recursive: true });
const { asSchema } = await import('ai');
const { frontSystemPrompt, CODING_AGENTS_PROMPT } = await import('../src/agent/prompts/front.js');
const { childSystemPrompt } = await import('../src/agent/prompts/child.js');
const { sandboxFrontPrompt, sandboxChildPrompt } = await import('../src/sandbox/prompts.js');
const { HUDDLE_DJ_PROMPT } = await import('../src/features/huddlefm/render.js');
await import('../src/tools/index.js');
await import('../src/agent/register.js');
await import('../src/features/register.js');
await import('../src/pipeline/register.js');
await import('../src/sandbox/register.js');
const { toolsFor } = await import('../src/core/tools.js');

writeFileSync(`${out}/front.txt`, frontSystemPrompt('smasnug ai'));
writeFileSync(`${out}/front_sandbox.txt`, sandboxFrontPrompt({ previews: true }));
writeFileSync(`${out}/front_huddle.txt`, HUDDLE_DJ_PROMPT);
writeFileSync(`${out}/front_coding.txt`, CODING_AGENTS_PROMPT);
writeFileSync(`${out}/child.txt`, childSystemPrompt(new Date('2026-10-07T00:00:00Z')));
writeFileSync(`${out}/child_sandbox.txt`, sandboxChildPrompt({ previews: true }));
for (const role of ['front', 'child'] as const) {
  const tools = toolsFor(role, { threadId: 'C1:1.000001', channelId: 'C1', threadTs: '1.000001', speakerId: 'U1', turnId: 1, runId: 1, subagentId: 'sa_x', extras: {} });
  const defs: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    defs[name] = { description: (t as any).description, parameters: await asSchema((t as any).inputSchema).jsonSchema };
  }
  writeFileSync(`${out}/tools_${role}.json`, JSON.stringify(defs, null, 1));
  for (const [name, d] of Object.entries(defs)) writeFileSync(`${out}/tool_${role}_${name}.json`, JSON.stringify(d));
}
process.exit(0);
