import { betterAuth } from "better-auth";
import { D1Dialect } from "kysely-d1";
import { json } from "./gui-http.js";
import type { AuthUser, Bindings, RequestContext } from "./gui-types.js";

export function sanitizeTenantId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 96) || "global";
}

export function authIsConfigured(env: Bindings): boolean {
  return Boolean(env.AUTH_DB && env.BETTER_AUTH_SECRET && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

export function publicBaseUrl(request: Request, env: Bindings): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const url = new URL(request.url);
  return url.origin;
}

export function authForRequest(request: Request, env: Bindings) {
  if (!authIsConfigured(env) || !env.AUTH_DB) return null;
  return betterAuth({
    appName: "King AI",
    baseURL: publicBaseUrl(request, env),
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: {
      dialect: new D1Dialect({ database: env.AUTH_DB }),
      type: "sqlite",
      transaction: false
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID || "",
        clientSecret: env.GITHUB_CLIENT_SECRET || ""
      }
    },
    trustedOrigins: [publicBaseUrl(request, env)]
  });
}

export async function getAuthUser(c: RequestContext): Promise<AuthUser | null> {
  const testUser = c.env.KING_AI_TEST_AUTH_USER ? c.req.header("X-King-AI-Test-User") : undefined;
  if (testUser) {
    const parsed = JSON.parse(testUser) as AuthUser;
    return { id: parsed.id, email: parsed.email, name: parsed.name };
  }
  const auth = authForRequest(c.req.raw, c.env);
  if (!auth) {
    if (isLocalDevRequest(c.req.raw)) {
      return { id: "local-dev", email: "local-dev@king-ai.local", name: "Local Dev" };
    }
    return null;
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ? { id: session.user.id, email: session.user.email, name: session.user.name } : null;
}

export function isLocalDevRequest(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function authUserFromRequest(request: Request): AuthUser | undefined {
  const raw = request.headers.get("X-King-AI-Auth-User");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as AuthUser;
    if (!parsed.id) return undefined;
    return { id: parsed.id, email: parsed.email, name: parsed.name };
  } catch {
    return undefined;
  }
}

export function displayNameForAuthUser(user: AuthUser | undefined): string {
  return user?.name?.trim() || user?.email?.trim() || user?.id?.trim() || "King AI Human";
}

export function tenantFromAuthUser(user: AuthUser): string {
  return `user-${sanitizeTenantId(user.email || user.id)}`;
}

export async function remoteAssistTenantFromRequest(c: RequestContext): Promise<string | undefined> {
  const url = new URL(c.req.url);
  const tokenValue = url.searchParams.get("assist") || c.req.header("X-King-AI-Assist-Token");
  const tenantValue = url.searchParams.get("tenant") || c.req.header("X-King-AI-Tenant");
  if (!tokenValue || !tenantValue) return undefined;
  const tenantId = sanitizeTenantId(tenantValue);
  const stub = c.env.GUI_STATE.get(c.env.GUI_STATE.idFromName(tenantId));
  const response = await stub.fetch("https://state/remote-assist/auth", {
    method: "POST",
    body: JSON.stringify({ token: tokenValue })
  });
  return response.ok ? tenantId : undefined;
}

export async function tenantFromRequest(c: RequestContext): Promise<string> {
  const url = new URL(c.req.url);
  const explicit = url.searchParams.get("tenant") || c.req.header("X-King-AI-Tenant");
  if (explicit) return sanitizeTenantId(explicit);
  const user = await getAuthUser(c);
  if (user) return tenantFromAuthUser(user);
  const accessEmail = c.req.header("Cf-Access-Authenticated-User-Email");
  if (accessEmail) return `user-${sanitizeTenantId(accessEmail)}`;
  const accessSub = c.req.header("Cf-Access-User-Sub");
  if (accessSub) return `user-${sanitizeTenantId(accessSub)}`;
  return "global";
}

export async function tenantForGuiRequest(c: RequestContext): Promise<string> {
  return await remoteAssistTenantFromRequest(c) ?? await tenantFromRequest(c);
}

export async function stateForTenant(c: RequestContext, tenantId: string): Promise<DurableObjectStub> {
  return c.env.GUI_STATE.get(c.env.GUI_STATE.idFromName(sanitizeTenantId(tenantId)));
}

export function splitPairCode(value: unknown): { tenantId?: string; code?: string } {
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0) return { code: trimmed };
  const tenantId = sanitizeTenantId(trimmed.slice(0, separator));
  const code = trimmed.slice(separator + 1);
  return code ? { tenantId, code } : { code: trimmed };
}

export function pairingLocator(args: { serverUrl: string; tenantId: string; code: string }): string {
  const params = new URLSearchParams({ server: args.serverUrl, code: args.code });
  if (args.tenantId !== "global") params.set("tenant", args.tenantId);
  return `king-ai://pair?${params.toString()}`;
}

export async function stateForRequest(c: RequestContext): Promise<DurableObjectStub> {
  return c.env.GUI_STATE.get(c.env.GUI_STATE.idFromName(await tenantForGuiRequest(c)));
}

export async function forwardHeaders(c: RequestContext, headers: Record<string, string> = {}): Promise<Headers> {
  const forwarded = new Headers(headers);
  const auth = c.req.header("Authorization");
  if (auth) forwarded.set("Authorization", auth);
  forwarded.set("X-King-AI-Tenant", await tenantForGuiRequest(c));
  forwarded.set("X-King-AI-Public-Base", publicBaseUrl(c.req.raw, c.env));
  const user = await getAuthUser(c);
  if (user) forwarded.set("X-King-AI-Auth-User", JSON.stringify(user));
  return forwarded;
}

export function bearer(c: { req: { header(name: string): string | undefined } }): string {
  const raw = c.req.header("Authorization") || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
}

function loginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>King AI Sign In</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #171717;
      background: #fff;
    }
    .topbar {
      height: 60px;
      display: flex;
      align-items: center;
      border-bottom: 2px solid #111;
      background: #ffd633;
      padding: 0 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #111;
      font-size: 18px;
      font-weight: 950;
      font-style: italic;
      letter-spacing: -0.02em;
      text-transform: uppercase;
      text-shadow: 2px 2px 0 #fff;
      -webkit-text-stroke: 1px #111;
    }
    .brand-mark {
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      border: 3px solid #111;
      border-radius: 3px;
      background: #fff;
      box-shadow: 2px 2px 0 #111;
      transform: rotate(-10deg);
      font-size: 11px;
      line-height: 1;
      text-shadow: none;
      -webkit-text-stroke: 0;
    }
    main {
      min-height: calc(100vh - 60px);
      display: grid;
      place-items: center;
      padding: 32px 16px;
    }
    .panel {
      width: min(450px, calc(100vw - 32px));
      display: grid;
      justify-items: center;
      gap: 20px;
    }
    .login-mark {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border: 4px solid #111;
      border-radius: 4px;
      box-shadow: 3px 3px 0 #111;
      transform: rotate(-10deg);
      font-weight: 950;
      line-height: 1;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 20px;
      line-height: 1.1;
      font-weight: 900;
      text-align: center;
    }
    button {
      width: 100%;
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border: 2px solid #111;
      background: #050505;
      color: #fff;
      box-shadow: 4px 5px 0 #222;
      font-weight: 900;
      cursor: pointer;
    }
    button:hover { background: #171717; }
    .github-icon {
      width: 18px;
      height: 18px;
      display: block;
      fill: currentColor;
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="brand-mark">↗</span>King AI</div>
  </header>
  <main>
    <section class="panel" aria-label="Sign in">
      <div class="login-mark">↗</div>
      <h1>Sign In</h1>
      <button id="githubSignIn"><svg class="github-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.64 0 8.49c0 3.75 2.39 6.93 5.7 8.05.42.08.57-.19.57-.42 0-.21-.01-.91-.01-1.65-2.32.55-2.81-1.04-2.81-1.04-.38-1-.93-1.27-.93-1.27-.76-.53.06-.52.06-.52.84.06 1.28.9 1.28.9.75 1.33 1.96.95 2.44.73.08-.56.29-.95.53-1.17-1.85-.22-3.79-.96-3.79-4.27 0-.94.32-1.71.86-2.31-.09-.22-.37-1.1.08-2.28 0 0 .7-.23 2.3.88A7.65 7.65 0 0 1 8 3.51c.71 0 1.43.1 2.1.29 1.59-1.11 2.29-.88 2.29-.88.45 1.18.17 2.06.08 2.28.54.6.86 1.37.86 2.31 0 3.32-1.95 4.05-3.8 4.27.3.27.56.79.56 1.6 0 1.16-.01 2.09-.01 2.37 0 .23.15.5.57.42A8.33 8.33 0 0 0 16 8.49C16 3.64 12.42 0 8 0Z"/></svg>Continue with GitHub</button>
    </section>
  </main>
  <script>
    document.getElementById('githubSignIn').addEventListener('click', async function() {
      const response = await fetch(location.origin + '/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: location.origin + '/' })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      location.href = payload.url || '/';
    });
  </script>
</body>
</html>`;
}

export async function requireGuiAuth(c: RequestContext): Promise<Response | null> {
  if (await remoteAssistTenantFromRequest(c)) return null;
  if (!authIsConfigured(c.env)) return null;
  const user = await getAuthUser(c);
  if (user) return null;
  if (new URL(c.req.url).pathname.startsWith("/gui/")) {
    return json({ error: "login_required" }, { status: 401 });
  }
  return new Response(loginPage(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: 401
  });
}

export async function requireOwnerGuiAuth(c: RequestContext): Promise<Response | null> {
  if (await remoteAssistTenantFromRequest(c)) return json({ error: "owner_login_required" }, { status: 403 });
  return requireGuiAuth(c);
}
