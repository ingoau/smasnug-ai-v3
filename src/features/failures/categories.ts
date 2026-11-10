/**
 * Failure categories, shared by the front agent's report_failure tool and the background review
 * (src/features/failures/). Pure: no I/O.
 */

export const FAILURE_CATEGORIES = [
  'gate_false_negative',
  'gate_false_positive',
  'incorrect_info',
  'incomplete',
  'misunderstood_request',
  'false_action_claim',
  'wrong_action',
  'missed_context',
  'tool_failure',
  'format_or_tone',
  'too_slow',
  'capability_gap',
  'other',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** One line each: the tool description and the review prompt both list these. */
export const CATEGORY_HELP: Record<FailureCategory, string> = {
  gate_false_negative: "someone clearly wanted the bot to answer a message and it stayed silent (e.g. a later \"hello??\" or \"why didn't you answer\")",
  gate_false_positive: 'the bot answered a message that was not for it ("I wasn\'t talking to you")',
  incorrect_info: 'the bot stated something false (a fact, a link, a name, a number, what a page or message says)',
  incomplete: 'it did only part of the task, gave up too early, or had to be asked to dig deeper / continue / do the rest',
  misunderstood_request: 'it answered a different question than the one asked ("no, I meant…")',
  false_action_claim: 'it said it did something (sent, reacted, created, remembered, set a reminder) that never happened',
  wrong_action: 'it took an action it should not have (wrong recipient or channel, unwanted reaction, unwanted memory, wrong file)',
  missed_context: 'it ignored something it had been given: earlier messages in the thread, a file, an image, a link',
  tool_failure: 'a tool or service failed or returned junk and the answer suffered (search empty, page blocked, sandbox died)',
  format_or_tone: 'right content, wrong delivery: far too long or short, wrong format, ignored a stated style preference',
  too_slow: 'the person complained it took too long',
  capability_gap: "it was asked for something it can't do (a missing tool or permission)",
  other: 'anything else; say what in the summary',
};

export const FAILURE_SIGNALS = ['explicit_complaint', 'correction', 'self_noticed'] as const;
export type FailureSignal = (typeof FAILURE_SIGNALS)[number] | 'hindsight';

export const FAILURE_LIMITS = {
  summaryMax: 300,
  quoteMax: 300,
  evidenceMax: 4,
  categoriesMax: 3,
  /** Self reports per thread per rolling day (one per turn on top). */
  selfPerThreadPerDay: 3,
  /** Findings kept per reviewed thread. */
  reviewFindingsMax: 5,
};

export function categoryList(): string {
  return FAILURE_CATEGORIES.map((c) => `- ${c}: ${CATEGORY_HELP[c]}`).join('\n');
}

/** Pure: dedupe, keep known categories, cap. 'other' only when it is alone. */
export function cleanCategories(input: readonly string[]): FailureCategory[] {
  const known = [...new Set(input)].filter((c): c is FailureCategory => (FAILURE_CATEGORIES as readonly string[]).includes(c));
  const specific = known.filter((c) => c !== 'other');
  return (specific.length ? specific : known).slice(0, FAILURE_LIMITS.categoriesMax);
}

export const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
