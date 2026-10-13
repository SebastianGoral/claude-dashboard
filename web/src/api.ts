/** POSTs JSON. Returns null on success, else the error text of the server. */
export async function post(url: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (res?.ok) return null;
  const data = await res?.json().catch(() => null);
  return data?.error ?? 'The server does not answer';
}

/** GETs JSON. Throws with the error text of the server. */
export async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}
