/** Short-lived server-side context for multi-agent workflows (avoids huge x402 pay URLs). */

const TTL_MS = 30 * 60 * 1000;
const store = new Map<string, { at: number; text: string }>();

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, row] of store) {
    if (row.at < cutoff) store.delete(id);
  }
}

export function stashWorkflowContext(text: string): string {
  prune();
  const id = crypto.randomUUID();
  store.set(id, { at: Date.now(), text: text.slice(0, 12_000) });
  return id;
}

export function readWorkflowContext(id: string): string {
  const row = store.get(id);
  if (!row) return "";
  if (Date.now() - row.at > TTL_MS) {
    store.delete(id);
    return "";
  }
  return row.text;
}
