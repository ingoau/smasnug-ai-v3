// Prints which tools each role is granted (safety comes from this roster, not prompts).
import '../src/tools/index.js';
import '../src/agent/register.js';
import '../src/features/register.js';
import '../src/pipeline/register.js';
import { registeredTools } from '../src/core/tools.js';

for (const role of ['gate', 'front', 'child'] as const) {
  console.log(`${role}: ${registeredTools().filter((t) => t.roles.includes(role)).map((t) => t.name).join(', ') || '(none)'}`);
}
process.exit(0);
