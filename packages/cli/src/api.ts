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

export function tenantHeader(tenantId?: string): Record<string, string> {
  return tenantId ? { "X-King-AI-Tenant": tenantId } : {};
}

export async function runtimePost<T>(serverUrl: string, path: string, token: string, body: unknown, tenantId?: string): Promise<T | null> {
  try {
    const res = await fetch(`${serverUrl}/runtime${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...tenantHeader(tenantId)
      },
      body: JSON.stringify(body)
    });
    return res.ok ? ((await res.json().catch(() => null)) as T | null) : null;
  } catch {
    return null;
  }
}

export async function runtimeGet<T>(serverUrl: string, path: string, token: string, tenantId?: string): Promise<T | null> {
  try {
    const res = await fetch(`${serverUrl}/runtime${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...tenantHeader(tenantId)
      }
    });
    return res.ok ? ((await res.json().catch(() => null)) as T | null) : null;
  } catch {
    return null;
  }
}

export async function runtimePostStrict<T>(serverUrl: string, path: string, token: string, body: unknown, tenantId?: string): Promise<T> {
  const res = await fetch(`${serverUrl}/runtime${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...tenantHeader(tenantId)
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json().catch(() => null)) as T;
}

export async function runtimeGetStrict<T>(serverUrl: string, path: string, token: string, tenantId?: string): Promise<T> {
  const res = await fetch(`${serverUrl}/runtime${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...tenantHeader(tenantId)
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json().catch(() => null)) as T;
}
