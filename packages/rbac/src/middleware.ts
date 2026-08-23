// middleware.ts — RBAC enforcement for the console API (BACK-OFFICE.md §9).
//
//   Cloudflare Access (perimeter: SSO/MFA) → signed identity header
//     → withIdentity(): resolve email → D1 (users→user_roles→role_permissions)
//       → requirePermission(p): deny-by-default + append-only audit on every decision.
//
// Local/staging-without-Access parity (BO §5): in non-prod we also accept a mock
// identity header so the loop works before Zero Trust Access is wired to the URL.

import type { Context, MiddlewareHandler } from 'hono';
import type { Permission } from './permissions.js';

const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';
const MOCK_EMAIL_HEADER = 'x-mock-user-email';

// The open read-only demo (SHOWCASE.md §5, SH-4). On a public demo host (env PUBLIC_DEMO_HOSTS,
// comma-separated; e.g. demo.example.com) EVERY identity header is ignored — the host is not
// behind Access, so the Access header is client-controlled there — and the caller becomes this
// synthetic identity, which holds the `public` role in D1. Safety comes from deny-by-default RBAC
// plus the non-GET block (`blockWritesOnPublicHost`), not from a login.
export const PUBLIC_DEMO_EMAIL = 'public@demo';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Structural parameter type so any Hono context (whatever its Variables) can be passed.
export function isPublicDemoHost(c: { env: { PUBLIC_DEMO_HOSTS?: string }; req: { url: string } }): boolean {
  const hosts = c.env.PUBLIC_DEMO_HOSTS;
  if (!hosts) return false;
  let host = '';
  try { host = new URL(c.req.url).hostname.toLowerCase(); } catch { return false; }
  return hosts.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).includes(host);
}

/**
 * Mount FIRST on the app: on a public demo host, reject every non-read request at the transport
 * level (before routing, before RBAC) so no write path is reachable there, whatever its guard.
 */
export function blockWritesOnPublicHost(): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicDemoHost(c as unknown as RbacContext) && !READ_METHODS.has(c.req.method)) {
      return c.json({ error: 'read_only_demo', message: 'This is the public read-only demo — writes are disabled.' }, 403);
    }
    await next();
  };
}

export interface Identity {
  email: string;
  permissions: Set<Permission>;
}

// Anything the middleware needs from the Worker Env.
export interface RbacBindings {
  DB: D1Database;
  ENVIRONMENT?: string; // 'local' | 'staging' | 'production'
  PUBLIC_DEMO_HOSTS?: string; // comma-separated hostnames that get the `public@demo` identity
}

// Hono Variables this package sets on the context.
export interface RbacVariables {
  identity: Identity;
}

type RbacContext = Context<{ Bindings: RbacBindings; Variables: RbacVariables }>;

function resolveEmail(c: RbacContext): string | null {
  // Public demo host: headers are untrusted there — always the synthetic public identity.
  if (isPublicDemoHost(c)) return PUBLIC_DEMO_EMAIL;

  const accessEmail = c.req.header(ACCESS_EMAIL_HEADER);
  if (accessEmail) return accessEmail.toLowerCase();

  // Mock identity is ONLY honoured in LOCAL dev — never in staging/prod, where a public
  // (non-Access) entry point (e.g. the workers.dev URL) could otherwise spoof an admin.
  // Staging/prod must present a real Cloudflare Access identity header.
  if (c.env.ENVIRONMENT === 'local') {
    const mock = c.req.header(MOCK_EMAIL_HEADER);
    if (mock) return mock.toLowerCase();
  }
  return null;
}

async function loadPermissions(db: D1Database, email: string): Promise<Set<Permission>> {
  const { results } = await db
    .prepare(
      `SELECT rp.permission AS permission
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE u.email = ? AND u.status = 'active'`,
    )
    .bind(email)
    .all<{ permission: Permission }>();
  return new Set((results ?? []).map((r) => r.permission));
}

async function audit(
  db: D1Database,
  actor: string | null,
  action: string,
  decision: 'allow' | 'deny',
  resource?: string,
  detail?: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (actor, action, resource, decision, detail)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(actor, action, resource ?? null, decision, detail ? JSON.stringify(detail) : null)
    .run();
}

/**
 * Resolve the caller's identity + effective permissions and attach them to the context.
 * 401 if no identity can be established. Mount this before any protected route.
 */
export function withIdentity(): MiddlewareHandler {
  return async (c, next) => {
    const ctx = c as RbacContext;
    const email = resolveEmail(ctx);
    if (!email) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    const permissions = await loadPermissions(ctx.env.DB, email);
    ctx.set('identity', { email, permissions });
    await next();
  };
}

/**
 * Assert a permission, deny-by-default. Writes an allow/deny row to audit_log either way.
 * Requires withIdentity() to have run first.
 */
export function requirePermission(permission: Permission): MiddlewareHandler {
  return async (c, next) => {
    const ctx = c as RbacContext;
    const identity = ctx.get('identity');
    const actor = identity?.email ?? null;

    // The anonymous public demo identity is not audited (it would only add noise rows per GET).
    const audited = actor !== PUBLIC_DEMO_EMAIL;
    if (!identity || !identity.permissions.has(permission)) {
      if (audited) await audit(ctx.env.DB, actor, permission, 'deny', c.req.path);
      return c.json({ error: 'forbidden', permission }, 403);
    }
    if (audited) await audit(ctx.env.DB, actor, permission, 'allow', c.req.path);
    await next();
  };
}
