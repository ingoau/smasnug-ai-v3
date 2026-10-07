/** Row shapes shared across modules (postgres.js camelCases columns). */
export interface TurnRow {
  id: number;
  threadId: string;
  authorId: string;
  /**
   * 'scheduled': a fired reminder or watch notification (input in scheduled_turn_inputs, src/features/schedule), or
   * the outcome of a confirmation the agent asked for (send_message / coding-agent launch; src/features/outcome-turn.ts).
   */
  kind: 'user' | 'synthesis' | 'scheduled';
  isMention: boolean;
  /**
   * Not a mention, but addressed to the bot all the same (no @mention needed): an answer to the bot's question or
   * offer, or a two-party / conversation-partner follow-up that passed the gate. Framed as "talking with you".
   */
  addressed?: boolean;
  messageTs: string[];
  cardId: number | null;
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'error';
  phase: 'tools' | 'final' | null;
}

export interface StoredMessage {
  channelId: string;
  ts: string;
  threadId: string | null;
  userId: string | null;
  botId: string | null;
  username: string | null;
  text: string;
  files: SlackFileRef[];
  editedAt: Date | null;
  deleted: boolean;
  /** Reactions on the message (kept current from reaction events). */
  reactions?: MessageReaction[];
}

/** One emoji's reactions on a message. `count` can exceed users.length (Slack truncates the user list). */
export interface MessageReaction {
  name: string;
  users: string[];
  count: number;
}

export interface SlackFileRef {
  id: string;
  name?: string;
  mimetype?: string;
  urlPrivate?: string;
  /** Bytes, as Slack reports it (file store metadata before the content is fetched). */
  size?: number;
}
