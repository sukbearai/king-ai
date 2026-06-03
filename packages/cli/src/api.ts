export async function api<T>(serverUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function runtimePost<T>(serverUrl: string, path: string, token: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${serverUrl}/runtime${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
    return res.ok ? ((await res.json().catch(() => null)) as T | null) : null;
  } catch {
    return null;
  }
}

export async function runtimeGet<T>(serverUrl: string, path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${serverUrl}/runtime${path}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    return res.ok ? ((await res.json().catch(() => null)) as T | null) : null;
  } catch {
    return null;
  }
}
