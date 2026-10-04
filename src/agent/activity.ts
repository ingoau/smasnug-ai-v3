/**
 * Code-derived activity labels for the status indicator (never model-facing). The front loop reports each tool
 * call as it starts; tools that just respond (reply / react / unreact, and the emoji lookup that precedes a
 * reaction) return null: they don't commit the turn to work, and a streamed reply is its own indicator.
 */
const LABELS: Record<string, string> = {
  web_search: 'Searching the web…',
  slack_search: 'Searching Slack…',
  fetch_url: 'Reading the page…',
  read_thread: 'Reading the thread…',
  read_public_thread: 'Reading a Slack thread…',
  read_channel: 'Reading the channel…',
  read_image: 'Looking at the image…',
  spawn_subagent: 'Starting a subagent…',
  message_subagent: 'Updating a subagent…',
  cancel_subagent: 'Stopping a subagent…',
  remember: 'Saving a note…',
  forget: 'Forgetting a note…',
  propose_workspace_fact: 'Noting a workspace fact…',
  send_message: 'Preparing a message…',
  set_card_title: 'Writing up the results…',
  slack_semantic_search: 'Searching Slack…',
  read_canvas: 'Reading the canvas…',
  create_canvas: 'Writing a canvas…',
  edit_canvas: 'Updating the canvas…',
  set_reminder: 'Setting a reminder…',
  list_reminders: 'Checking reminders…',
  cancel_reminder: 'Cancelling a reminder…',
  create_watch: 'Setting up a watch…',
  list_watches: 'Checking watches…',
  cancel_watch: 'Cancelling a watch…',
  spawn_coding_agent: 'Preparing a coding agent…',
};

/** Tools that only respond; they never show or change the indicator. */
const RESPONDING = new Set(['reply', 'react', 'unreact', 'search_emojis', 'end_turn']);
/** Bookkeeping (DM session title, leaving / closing the conversation): not work either, no card flashing after a reply. */
for (const name of ['set_session_title', 'leave_thread']) RESPONDING.add(name);
/** Tools that must stay invisible in the thread (report_user is never hinted at). */
const SILENT = new Set(['report_user']);

export const DEFAULT_ACTIVITY = 'Working…';

/** The status text for a tool call that just started, or null if it shouldn't show/change the indicator. */
export function activityForTool(toolName: string): string | null {
  if (RESPONDING.has(toolName) || SILENT.has(toolName)) return null;
  return LABELS[toolName] ?? DEFAULT_ACTIVITY;
}
