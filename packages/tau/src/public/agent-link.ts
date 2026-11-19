/** The agent this browser shows lives in its URL (`#agent=<muxId>`), so a reload or bookmark returns to it. */
export function agentFromHash(hash: string): string | null {
  if (!hash.startsWith('#agent=')) return null;
  try {
    const id = decodeURIComponent(hash.slice('#agent='.length));
    return id && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function agentHash(muxId: string | null): string {
  return muxId ? `#agent=${encodeURIComponent(muxId)}` : '';
}
