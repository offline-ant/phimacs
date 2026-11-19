/**
 * Decides which of a project's saved sessions History renders.
 */

export const SESSION_LIMIT = 10;

export type SessionLimitInput<T> = {
  /** The project's sessions, newest first. */
  sessions: T[];
  /** True when every session is wanted: the user asked for all, or a filter is applied. */
  expanded: boolean;
  limit?: number;
};

export type SessionLimitResult<T> = {
  visible: T[];
  /** Sessions beyond the limit. It is 0 when all of them are shown. */
  hiddenCount: number;
  /** True when the project has more sessions than the limit. */
  limited: boolean;
};

export function limitSessions<T>(input: SessionLimitInput<T>): SessionLimitResult<T> {
  const { sessions, expanded, limit = SESSION_LIMIT } = input;
  const limited = sessions.length > limit;
  if (!limited || expanded) return { visible: sessions, hiddenCount: 0, limited };
  return { visible: sessions.slice(0, limit), hiddenCount: sessions.length - limit, limited };
}
