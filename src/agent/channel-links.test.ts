import '../tools/test-env.js';
import { describe, expect, it } from 'vitest';
import { channelSafePrefix, linkifyChannels } from './channel-links.js';

const names = new Map([
  ['ship', 'C0M8PUPU6'],
  ['help', 'C0HELP'],
]);

describe('linkifyChannels', () => {
  it('links bare #names of known channels', () => {
    expect(linkifyChannels('post it in #ship or ask in #help.', names)).toBe('post it in <#C0M8PUPU6> or ask in <#C0HELP>.');
  });
  it('leaves unknown names, existing links, headings-ish and code alone', () => {
    expect(linkifyChannels('#1 pick, #unknown, <#C0M8PUPU6|ship>, `#ship`, ```\n#ship\n```', names)).toBe(
      '#1 pick, #unknown, <#C0M8PUPU6|ship>, `#ship`, ```\n#ship\n```',
    );
  });
  it('is case-insensitive on the name', () => {
    expect(linkifyChannels('see #Ship', names)).toBe('see <#C0M8PUPU6>');
  });
});

describe('channelSafePrefix', () => {
  it('holds back a trailing partial channel name', () => {
    expect(channelSafePrefix('post it in #shi')).toBe('post it in ');
    expect(channelSafePrefix('post it in #ship now')).toBe('post it in #ship now');
  });
});
