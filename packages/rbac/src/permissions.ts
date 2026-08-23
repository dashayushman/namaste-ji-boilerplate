// permissions.ts — the BO permission vocabulary + role matrix (BACK-OFFICE.md §9).
//
// This is the single source of truth shared by the API middleware AND the console UI
// (so the UI can hide what the API would forbid — defence in depth, not the only line).
// It MIRRORS the seed in services/console-api/migrations/0001_rbac.sql — keep them in
// sync (the DB is authoritative at request time; this enum is the typed contract).

export const PERMISSIONS = [
  'brief:read', 'brief:create', 'brief:approve',
  'content:read', 'content:publish', 'content:unpublish', 'content:delete',
  // Calendar (events) write path — managed from the BO Agent Hub. Distinct from content:*
  // because events are the shared spine, not published creative assets.
  'calendar:write', 'calendar:approve',
  'agent:view', 'agent:run', 'agent:schedule', 'agent:configure',
  // Curate an agent's long-term memory (pin/edit/retract learned lessons). Viewing memory is
  // covered by agent:view; mutating it is a distinct, higher-trust action.
  'memory:curate',
  'control:set_mode', 'control:kill_switch',
  'validation:submit',
  'user:invite', 'user:assign_role',
  // Manage CONSUMER app users (create/reset/ban/role via the consumer-api service
  // binding). Distinct from user:* (BO operators) so the audit log is unambiguous
  // about which trust plane was touched (docs/FRONTEND.md).
  'consumer:manage',
  'audit:read', 'config:edit',
  // Feed Lab (docs/console/FEED-LAB.md): view the surfaces / run sims + rebuilds / author policy
  // drafts / move the staging+production labels (the ship gate — highest trust, admin-only seed).
  'lab:view', 'lab:run', 'feed_policy:edit', 'feed_policy:promote',
  // Heimdall — the QA/eval plane (CONTENT-PRODUCTION.md §12/§15): view scorecards/timelines/
  // provenance · trigger/extend an eval-run · resolve a flag / override a veto (high-trust).
  'eval:read', 'eval:run', 'eval:override',
  // Temple live-darshan (docs/TEMPLE-LIVE-DARSHAN.md): view the catalog · edit metadata/streams +
  // verify · publish/unpublish/retire (the consumer-visibility gate — high-trust, like content:publish).
  'temple:read', 'temple:edit', 'temple:publish',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['admin', 'creative-lead', 'engineer', 'reviewer', 'viewer', 'public'] as const;
export type Role = (typeof ROLES)[number];

// Seed matrix — mirrors the SQL. `admin` is the only role populated onto a user for MVP.
export const ROLE_MATRIX: Record<Role, Permission[]> = {
  admin: [...PERMISSIONS], // superuser
  'creative-lead': [
    'brief:read', 'brief:create', 'brief:approve',
    'content:read', 'content:publish', 'content:unpublish',
    'calendar:write', 'calendar:approve',
    'agent:view', 'agent:run', 'agent:schedule',
    'memory:curate',
    'validation:submit',
    'control:set_mode', // per-stage only; global mode + kill switch stay admin-only
    'audit:read',
    'lab:view', 'lab:run', 'feed_policy:edit', // promote (the ship gate) stays admin-only
    'eval:read', 'eval:run', // override (veto escape hatch) stays admin-only
    'temple:read', 'temple:edit', 'temple:publish', // curates + ships live-darshan (like content:publish)
  ],
  engineer: ['agent:view', 'audit:read', 'brief:read', 'content:read', 'lab:view', 'eval:read', 'temple:read'],
  reviewer: ['validation:submit', 'brief:read', 'content:read', 'eval:read', 'temple:read'],
  viewer: ['agent:view', 'audit:read', 'brief:read', 'content:read', 'lab:view', 'eval:read', 'temple:read'],
  // The open read-only demo (SHOWCASE.md §5, SH-4): assigned to the synthetic `public@demo` identity
  // on the public demo host. Deliberately NOT audit:read (operator emails). Every non-GET is rejected
  // at the transport level before RBAC even runs.
  public: ['agent:view', 'brief:read', 'content:read', 'lab:view', 'eval:read', 'temple:read'],
};
