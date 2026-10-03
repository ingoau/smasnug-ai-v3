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
}

export interface SlackFileRef {
  id: string;
  name?: string;
  mimetype?: string;
  urlPrivate?: string;
}
