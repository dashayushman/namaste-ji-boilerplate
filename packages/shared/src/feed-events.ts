/**
 * The Feed Event contract — the ONE interaction taxonomy shared by every event source
 * (docs/console/FEED-LAB.md §6.2, docs/DISTRIBUTION.md DS-10, docs/EVENTS-AND-ANALYTICS.md §3).
 *
 * Emitted identically by: the founder scrolling the Lab's phone frame (`source:'founder'`),
 * the statistical persona simulator (`'persona'`), the LLM persona agent (`'llm'`), and the
 * real consumer app (`'app'`). Because every layer speaks this schema, simulated and real
 * behaviour are directly comparable (that's how the persona model gets calibrated), and
 * nothing built for the Lab is thrown away when the app ships.
 *
 * Schema v2 (EVENTS-AND-ANALYTICS §3) extends v1 — it does not replace it:
 *  - new variants `like`/`unlike`/`save`/`unsave` (state writes emit events, EV-2/EV-3);
 *    `download` stays folded into `open` (EV OQ-1 resolved: no own variant yet)
 *  - the app-era ENVELOPE (Segment/Snowplow canonical fields): `event_id` (dedup key),
 *    `request_id` (the feed-serve join token, EV-5), `user_pseudo_id` (EV-11), `purpose`
 *    (DPDP purpose tag), client `occurred_at`/`sent_at` (skew correction at ingest)
 * Envelope fields are OPTIONAL here so every stored v1 Lab row still parses; the app
 * ingest path validates against `ingestFeedEventSchema`, which REQUIRES the client half
 * of the envelope. Consumers branch on `schema_version`.
 *
 * Sinks are pluggable behind `EventSink` (FL-13): the Lab writes full-fidelity rows to D1;
 * the app era adds the consumer-api D1/WAE/Pipelines sinks behind the same port.
 */
import { z } from 'zod';
import { languageSchema } from './brief';

/** Current feed-event contract version. Bump on incompatible changes. */
export const FEED_EVENT_SCHEMA_VERSION = 2;

/** Who produced the event — the calibration axis (Lab layers vs the real app). */
export const feedEventSourceSchema = z.enum(['founder', 'persona', 'llm', 'app']);
export type FeedEventSource = z.infer<typeof feedEventSourceSchema>;

/** Where the event happened. One surface today; additive later (widget, share sheet, …). */
export const feedSurfaceSchema = z.enum(['lab_simulator', 'app_feed']);

/** Coarse daypart — a first-class ranking input (morning GM ritual), so it rides every event. */
export const timeOfDaySchema = z.enum(['morning', 'midday', 'evening', 'night']);
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;

/**
 * DPDP purpose tag (EV §7.4): stamped at capture so "withdraw personalization but keep ops
 * telemetry" stays implementable. One value per event — the bucket consent gating acts on.
 */
export const eventPurposeSchema = z.enum(['analytics', 'personalization', 'ops']);
export type EventPurpose = z.infer<typeof eventPurposeSchema>;

/**
 * Context every event carries. `session_id` + `seq` give a total order for replay;
 * locale/daypart make aggregates sliceable without joins.
 *
 * `ts` is the CANONICAL timestamp: wall clock in the Lab; at app ingest the server
 * overwrites it with the skew-corrected value `received_at − (sent_at − occurred_at)`.
 */
const feedEventBase = {
  schema_version: z.number().default(FEED_EVENT_SCHEMA_VERSION),
  session_id: z.string(),
  seq: z.number().int().nonnegative(), // monotonic within the session — replay order
  ts: z.string(), // ISO canonical timestamp (see above)
  content_id: z.string(),
  source: feedEventSourceSchema,
  surface: feedSurfaceSchema.default('lab_simulator'),
  language: languageSchema.optional(), // viewer's language at event time
  region: z.string().optional(), // ISO-3166-2
  time_of_day: timeOfDaySchema.optional(),

  // ── v2 envelope (EV §3) — optional here; ingest requires the client half ─────────────
  event_id: z.string().max(64).optional(), // client UUID — the dedup/idempotency key
  request_id: z.string().max(128).optional(), // feed-serve token, echoed from PlaylistPage (EV-5)
  user_pseudo_id: z.string().max(64).optional(), // stamped SERVER-side at ingest (EV-11)
  purpose: eventPurposeSchema.optional(), // DPDP purpose tag
  occurred_at: z.string().optional(), // client clock: when it happened
  sent_at: z.string().optional(), // client clock: when the batch was flushed
};

/**
 * The taxonomy (DS-10 + EV §3). Deliberately small: `share_intent` is the north-star signal;
 * `dwell`/`skip` quantify it; `impression` is the denominator; `like`/`save` are the OLTP
 * state changes echoed into the stream (set-state, so `unlike`/`unsave` are first-class).
 *  - impression   — the card was on screen (position = index within the session's scroll)
 *  - dwell        — how long it held the screen before the user moved on
 *  - skip         — fast swipe-away (a *negative* preference signal, CLICK>SKIP-style)
 *  - open         — tapped into the card (download/zoom stays an `open` sub-kind for now)
 *  - like/unlike  — the like set-state changed (EV-3)
 *  - save/unsave  — the save set-state changed (EV-3)
 *  - share_intent — tapped share/WhatsApp — the objective (DS-2), logged pre-send (light/safe)
 */
const feedEventVariants = <B extends z.ZodRawShape>(base: B) =>
  [
    z.object({ ...base, type: z.literal('impression'), position: z.number().int().nonnegative() }),
    z.object({ ...base, type: z.literal('dwell'), dwell_ms: z.number().nonnegative() }),
    z.object({ ...base, type: z.literal('skip'), dwell_ms: z.number().nonnegative().optional() }),
    z.object({ ...base, type: z.literal('open') }),
    z.object({ ...base, type: z.literal('like') }),
    z.object({ ...base, type: z.literal('unlike') }),
    z.object({ ...base, type: z.literal('save') }),
    z.object({ ...base, type: z.literal('unsave') }),
    z.object({ ...base, type: z.literal('share_intent'), channel: z.enum(['whatsapp', 'other']).default('whatsapp') }),
  ] as const;

export const feedEventSchema = z.discriminatedUnion('type', feedEventVariants(feedEventBase));
export type FeedEvent = z.infer<typeof feedEventSchema>;
export type FeedEventType = FeedEvent['type'];

/**
 * What the app's `/api/events` ingest accepts (EV §4): the same taxonomy with the CLIENT half
 * of the envelope mandatory — `event_id` (dedup), `occurred_at`/`sent_at` (skew correction).
 * `user_pseudo_id` is deliberately NOT accepted from the client: the server pseudonymizes at
 * ingest (EV-11) and also stamps `purpose` defaults + the canonical `ts`.
 */
export const ingestFeedEventSchema = z.discriminatedUnion(
  'type',
  feedEventVariants({
    ...feedEventBase,
    schema_version: z.literal(FEED_EVENT_SCHEMA_VERSION).default(FEED_EVENT_SCHEMA_VERSION),
    ts: z.string().optional(), // server-computed; anything the client sends is ignored
    event_id: z.string().min(8).max(64),
    occurred_at: z.string(),
    sent_at: z.string(),
    user_pseudo_id: z.undefined().optional(),
    source: z.literal('app').default('app'),
    surface: feedSurfaceSchema.default('app_feed'),
  }),
);
export type IngestFeedEvent = z.infer<typeof ingestFeedEventSchema>;

/**
 * The pluggable sink port (FL-13/EV §4). Lab impl = full-fidelity D1 rows; app-era impls =
 * consumer D1 (source of signals), WAE (ops sidecar), Pipelines→Iceberg (lake). Writers MUST
 * validate against `feedEventSchema` before persisting.
 */
export interface EventSink {
  write(events: FeedEvent[]): Promise<void>;
}
