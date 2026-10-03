/** Row shapes shared across modules (postgres.js camelCases columns). */
export interface TurnRow {
  id: number;
  threadId: string;
  authorId: string;
  kind: 'user' | 'synthesis';
  isMention: boolean;
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
}
