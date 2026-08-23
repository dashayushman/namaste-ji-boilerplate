/**
 * The TEMPLE LIVE-DARSHAN contract — the shapes that describe a devotional live-stream in the
 * catalog. See docs/TEMPLE-LIVE-DARSHAN.md.
 *
 * SINGLE SOURCE OF TRUTH for the boundary between the back-office (the AUTHOR — curates temples via
 * the console), the catalog D1 (system of record), and the consumer plane (the READER — the "Live
 * Darshan" surface). Unlike generated content, temples are HUMAN-CURATED, not produced by an agent.
 *
 * Two entities, deliberately split (docs §3, principle P1):
 *   - TEMPLE  — the DURABLE thing a user saves / watchlists / subscribes to. Stable `temple_id`.
 *   - STREAM  — an EPHEMERAL pointer to a live video source. Rotates daily, dies often, is swappable
 *               UNDER the temple without the user noticing. A temple has 0..N streams.
 *
 * Like the content contract (see ./content), these are VERSIONED and persisted as a JSON `payload`
 * with only query-critical fields promoted to indexed D1 columns — the shape evolves with no
 * migration. Consumers branch on `schema_version`; bump TEMPLE_SCHEMA_VERSION on an incompatible
 * change.
 *
 * LEGAL NOTE (docs §7): we NEVER host or re-encode temple video. A stream is a POINTER we render
 * through the source's own embedded player (YouTube IFrame Player API, whose ToS grants an embedding
 * sublicense). `source_authority` records provenance so we prefer official/government sources and
 * can honour takedowns instantly.
 */
import { z } from 'zod';

/** Current temple-contract version. Bump on incompatible changes. */
export const TEMPLE_SCHEMA_VERSION = 1;

/**
 * Primary deity / focus of veneration — canonical lowercase slugs. This is a curation facet, not an
 * exhaustive theological taxonomy; extend the list as the catalog grows (no migration — it lives in
 * the JSON payload AND a promoted column, both plain TEXT).
 */
export const templeDeitySchema = z.enum([
  'shiva', 'vishnu', 'krishna', 'rama', 'devi', 'durga', 'kali', 'lakshmi',
  'ganesha', 'murugan', 'ayyappa', 'hanuman', 'sai', 'shani', 'sikh', 'other',
]);
export type TempleDeity = z.infer<typeof templeDeitySchema>;

/** Broad tradition / sampradaya. */
export const templeTraditionSchema = z.enum([
  'shaiva', 'vaishnava', 'shakta', 'smarta', 'sikh', 'other',
]);
export type TempleTradition = z.infer<typeof templeTraditionSchema>;

/** Notable classification, if any (drives discovery collections in the app). */
export const templeSignificanceSchema = z.enum([
  'jyotirlinga', 'shakti-peetha', 'char-dham', 'divya-desam', 'none', 'other',
]);
export type TempleSignificance = z.infer<typeof templeSignificanceSchema>;

/**
 * PROVENANCE of a stream — the legal spine (docs §7). We prefer authoritative sources and record
 * this on every stream so a BO reviewer, a takedown, or an audit can reason about rights.
 *  - official_temple_trust — the temple board's / trust's own channel (best)
 *  - government            — a Government of India portal (e.g. Ministry of Culture utsav.gov.in)
 *  - verified_broadcaster  — a known media partner re-broadcasting with apparent rights
 *  - unverified            — a source whose rights we have NOT confirmed (never publish as-is)
 */
export const sourceAuthoritySchema = z.enum([
  'official_temple_trust', 'government', 'verified_broadcaster', 'unverified',
]);
export type SourceAuthority = z.infer<typeof sourceAuthoritySchema>;

/** Where the stream lives. `youtube` is the default (embeddable player + resolvable live id). */
export const streamPlatformSchema = z.enum(['youtube', 'website', 'hls', 'other']);
export type StreamPlatform = z.infer<typeof streamPlatformSchema>;

/**
 * EDITORIAL lifecycle of a temple — the curation state a BO user drives (docs §4/§5). Deliberately
 * SHORT (a temple is curated, not generated — it does not need the 15-state content machine).
 * ORTHOGONAL to `health` below (a `published` temple can be `offline` at night — that is normal).
 *  - draft       — being added; not visible to anyone but the BO
 *  - in_review   — metadata + at least one stream present; awaiting verify + publish
 *  - published   — LIVE to consumers (subject to per-env status gating)
 *  - unpublished — pulled from consumers (reversible); a soft state, NOT a delete
 *  - retired     — permanently withdrawn (e.g. rights revoked); tombstoned for anyone who saved it
 */
export const templeStatusSchema = z.enum([
  'draft', 'in_review', 'published', 'unpublished', 'retired',
]);
export type TempleStatus = z.infer<typeof templeStatusSchema>;

/** The set of statuses a consumer plane may ever surface. Prod gates to `published` only (docs §8). */
export const CONSUMER_VISIBLE_STATUSES: TempleStatus[] = ['published'];

/**
 * RUNTIME health of a stream / temple — DERIVED by the resolver (docs §6), never hand-edited.
 * Orthogonal to editorial `status`.
 *  - live      — a resolvable, embeddable live broadcast right now
 *  - offline   — source is up but not broadcasting now (between darshan hours) — the NORMAL rest state
 *  - degraded  — reachable but with problems (embedding disabled, only a low-authority fallback left)
 *  - dead      — N consecutive failures; treat as gone until re-verified
 *  - unknown   — never checked yet
 */
export const streamHealthSchema = z.enum(['live', 'offline', 'degraded', 'dead', 'unknown']);
export type StreamHealth = z.infer<typeof streamHealthSchema>;

/** One aarti / ritual slot, for "next aarti" hints + notify-when-live (docs §9). */
export const aartiSlotSchema = z.object({
  name: z.string(),                 // 'Mangala Aarti', 'Sandhya Aarti'
  time: z.string(),                 // 'HH:MM' local (24h)
  days: z.array(z.string()).optional(), // ['mon',...]; omitted = daily
});
export type AartiSlot = z.infer<typeof aartiSlotSchema>;

export const templeScheduleSchema = z.object({
  timezone: z.string().default('Asia/Kolkata'),
  aarti_times: z.array(aartiSlotSchema).default([]),
  notes: z.string().optional(),     // e.g. 'darshan 04:00–23:00'
});
export type TempleSchedule = z.infer<typeof templeScheduleSchema>;

/**
 * A FREELY-LICENSED still image for the temple (docs §7 legal). We store the license + attribution
 * because reuse (even of Wikimedia/CC media) is conditional on crediting the author. `r2_key` is set
 * once we cache the bytes to our own R2 (optional; hotlinking the source is allowed with attribution).
 */
export const templeImageSchema = z.object({
  source_url: z.string().url().optional(),   // the Commons/File description page
  file_url: z.string().url().optional(),     // direct bytes (hotlink source, with attribution)
  r2_key: z.string().optional(),             // our cached copy, if any
  license: z.string(),                        // 'CC BY-SA 4.0', 'Public domain', …
  author: z.string().optional(),
  attribution: z.string(),                    // the credit string we MUST render
  placeholder: z.string().optional(),         // ThumbHash/BlurHash LQIP
});
export type TempleImage = z.infer<typeof templeImageSchema>;

/**
 * A TEMPLE STREAM — one live-video pointer. EPHEMERAL: `current_video_id` rotates (a channel's live
 * broadcast gets a new id each session) so we store the STABLE `channel_id`/`channel_url` and resolve
 * the current live id on a schedule (docs §6). Priority orders fallbacks (0 = primary).
 */
export const templeStreamSchema = z.object({
  schema_version: z.number().default(TEMPLE_SCHEMA_VERSION),
  stream_id: z.string(),
  temple_id: z.string(),
  platform: streamPlatformSchema.default('youtube'),
  source_authority: sourceAuthoritySchema,

  // Stable source identity (survives id rotation)
  channel_id: z.string().nullable().default(null),      // YouTube UC… (resolved), null until known
  channel_url: z.string().url().nullable().default(null),
  channel_handle: z.string().nullable().default(null),  // '@SVBCTTD'
  live_page_url: z.string().url().nullable().default(null), // official temple live-darshan page

  // Resolved runtime pointer (rotates) — the thing the player actually embeds
  current_video_id: z.string().nullable().default(null),    // resolved live video id
  embed_url: z.string().url().nullable().default(null),     // website/hls fallback embed
  is_embeddable: z.boolean().nullable().default(null),      // YouTube status.embeddable

  priority: z.number().int().nonnegative().default(0),      // 0 = primary; higher = fallback order
  health: streamHealthSchema.default('unknown'),
  last_checked_at: z.string().nullable().default(null),
  consecutive_failures: z.number().int().nonnegative().default(0),

  notes: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type TempleStream = z.infer<typeof templeStreamSchema>;

/**
 * A TEMPLE — the durable catalog entity. The JSON `payload` (everything below the promoted columns)
 * is evolvable. A user SAVES / WATCHLISTS / SUBSCRIBES to `temple_id`, never to a stream — that is
 * what lets streams rotate and die without breaking anyone (principle P1).
 */
export const templeSchema = z.object({
  schema_version: z.number().default(TEMPLE_SCHEMA_VERSION),
  temple_id: z.string(),            // stable, e.g. 'temple_kashi-vishwanath'
  slug: z.string(),                 // unique kebab-case

  // Identity + discovery facets (promoted columns)
  name: z.string(),
  deity: templeDeitySchema,
  tradition: templeTraditionSchema.default('other'),
  significance: templeSignificanceSchema.default('none'),
  state: z.string().optional(),     // Indian state (a primary discovery facet)
  city: z.string().optional(),
  country: z.string().default('India'),

  // Editorial + runtime state (promoted columns)
  status: templeStatusSchema.default('draft'),
  health: streamHealthSchema.default('unknown'),        // rolled up from streams
  primary_stream_id: z.string().nullable().default(null),
  verified_at: z.string().nullable().default(null),     // last human "I watched it, it's correct"
  verified_by: z.string().nullable().default(null),     // operator email

  // Payload (evolvable)
  languages: z.array(z.string()).default([]),           // ['hi','en','te'] — likely stream languages
  lat: z.number().nullable().default(null),
  lng: z.number().nullable().default(null),
  description: z.record(z.string(), z.string()).optional(), // per-language short blurb
  schedule: templeScheduleSchema.optional(),
  image: templeImageSchema.nullable().default(null),

  // Provenance / legal (docs §7)
  rights_holder: z.string().optional(),                 // who owns the underlying broadcast
  takedown_contact: z.string().optional(),              // where a rights complaint routes
  provenance_notes: z.string().optional(),

  // Merge/redirect: if this temple was deduped into another, point saved users at the canonical one.
  merged_into: z.string().nullable().default(null),

  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type Temple = z.infer<typeof templeSchema>;

/** A temple joined with its streams — the detail shape the BO + consumer read. */
export const templeWithStreamsSchema = templeSchema.extend({
  streams: z.array(templeStreamSchema).default([]),
});
export type TempleWithStreams = z.infer<typeof templeWithStreamsSchema>;

/**
 * The SAVED-STATE view the consumer plane returns for a user's watchlist (docs §5, the graceful-
 * degradation contract). Every saved temple_id resolves to one of these presentation states so the
 * client NEVER silently drops a save or renders a blank card:
 *  - available   — published + payload present; render normally (health says live/offline)
 *  - unavailable — published but health=dead/degraded with no playable stream; "temporarily unavailable"
 *  - tombstoned  — unpublished/retired/merged/missing; render a "no longer available" card + redirect
 */
export const savedTempleStateSchema = z.enum(['available', 'unavailable', 'tombstoned']);
export type SavedTempleState = z.infer<typeof savedTempleStateSchema>;

export const savedTempleSchema = z.object({
  temple_id: z.string(),
  state: savedTempleStateSchema,
  redirect_to: z.string().nullable().default(null), // canonical temple_id when merged
  temple: templeWithStreamsSchema.nullable().default(null), // present unless hard-gone
});
export type SavedTemple = z.infer<typeof savedTempleSchema>;
