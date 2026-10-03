// OWNER: features module. Stub signatures — implemented by the features agent.

/** Approved workspace facts for the stable prompt prefix. */
export async function renderWorkspaceFacts(): Promise<string> {
  return '';
}

/** The current speaker's facts (cap ~20) as `[m_42] prefers short answers`, labelled private. Touches last_used. */
export async function renderSpeakerMemory(userId: string): Promise<string> {
  return '';
}
