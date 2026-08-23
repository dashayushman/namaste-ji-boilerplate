/**
 * The Content Brief contract — the Creative Head's executable output.
 *
 * A brief is ONE self-contained generation job: the (future) Content-Generation agent picks up a
 * single brief and produces `count` assets from it with ZERO strategy context. This Zod schema is
 * the SINGLE SOURCE OF TRUTH for that contract — both the Creative Head (producer) and the
 * Content-Gen agent (consumer) import it, so the boundary can never drift.
 *
 * Evolvability (a first principle — see the plan): the brief is a VERSIONED contract. Every brief
 * carries `schema_version`; it is persisted as a JSON payload (not a column-per-field table) so the
 * shape can change tomorrow without a D1 migration. Consumers branch on `schema_version`; old
 * payloads keep parsing. Bump BRIEF_SCHEMA_VERSION whenever the shape changes incompatibly.
 */
import { z } from 'zod';

/** Current brief contract version. Bump on incompatible changes. */
export const BRIEF_SCHEMA_VERSION = 2;

/**
 * FORM FACTOR — the physical shape every generated asset must take, decided upstream (strategy →
 * brief → shot) and honoured AT GENERATION TIME (never cropped: images carry composed subjects + text).
 * For now the product is a single surface — a full-screen vertical reel for the mobile feed. The enum
 * is the only contract here; the concrete generation size lives with the production code (see
 * FORM_FACTOR / resolveGenSize in ./content) so the brief stays presentation-agnostic.
 */
export const formFactorSchema = z.enum(['feed_reel']);
export type FormFactor = z.infer<typeof formFactorSchema>;

/**
 * Languages we generate for, for now: Hindi (Devanagari), English, and Hinglish (Hindi written in
 * Latin script). More will be added later — additive, so consumers must tolerate unknown values
 * defensively, but the producer only emits these.
 */
export const LANGS = ['hi', 'en', 'hi-Latn'] as const;
export const languageSchema = z.enum(LANGS);
export type Language = (typeof LANGS)[number];

/** Whether content is evergreen (long shelf life) or pinned to a dated occasion (campaign window). */
export const temporalClassSchema = z.enum(['timeless', 'time_bound']);

/**
 * Where a brief sits in the portfolio's DIVERSITY spread. Diversity is the primary lever for
 * maximizing forwards (amplify the recipe, not the dish), so every brief declares its axes — the
 * `diversity_audit` reasons over the SET of these to ensure coverage + intra-list diversity.
 */
export const varietyAxesSchema = z.object({
  deity: z.string().optional(),
  festival: z.string().optional(),
  art_style: z.string().optional(),
  audience_cohort: z.enum(['senior', 'millennial', 'gen-z', 'all']).optional(),
  emotion: z.string().optional(),
});

/**
 * Geography as a FIRST-CLASS targeting axis: regional deities, aesthetics, and language pockets all
 * differ, and festival dates vary by region. `regions` are ISO-3166-2 codes (e.g. 'IN-MH'); omit /
 * empty ⇒ pan-India.
 */
export const geoTargetingSchema = z.object({
  scope: z.enum(['national', 'regional', 'state', 'city']),
  countries: z.array(z.string()).default(['IN']),
  regions: z.array(z.string()).optional(),
  regional_notes: z.string().optional(),
});

/**
 * Per-geo scheduling window for TIME-SENSITIVE batches. A festival lands on different dates across
 * regions, so each region gets its own validated `instance_date` (sourced from the events-calendar,
 * NEVER LLM-guessed) plus the campaign window the distribution layer honours.
 */
export const geoWindowSchema = z.object({
  region: z.string(), // ISO-3166-2 or 'IN' for pan-India
  instance_date: z.string(), // YYYY-MM-DD — from events-calendar
  prebuild_by: z.string(), // hard generation deadline (lead time before promote)
  promote_from: z.string(),
  peak: z.string(),
  decay_until: z.string(),
});

export const scheduleSchema = z.object({
  // Evergreen: cadence + local delivery time. Time_bound: per-geo windows (above).
  cadence: z.enum(['daily', 'weekly', 'one-shot']).optional(),
  deliver_local_time: z.string().optional(), // 'HH:MM' local — Good-Morning content peaks pre-08:00
  geo_windows: z.array(geoWindowSchema).optional(),
});

/** What downstream feeds/recommenders need; `feature` is the surface, `priority` the ranking boost. */
export const deliverySchema = z.object({
  feature: z.string(), // 'daily-darshan' | 'for-you' | …
  priority: z.number().default(0),
});

/**
 * The attribute tags each generated asset MUST carry. This DOUBLES as the content-catalog
 * write-contract: when the catalog is built, the Content-Gen agent writes assets back tagged to
 * exactly this spec, which is what powers attribute-level share-signal mining later.
 */
export const metadataSpecSchema = z.object({
  deity: z.string().optional(),
  motif: z.string().optional(),
  palette: z.string().optional(),
  font: z.string().optional(), // the font used for any text overlay (records the typography choice)
  region: z.string().optional(),
  theme_tag: z.string(),
  language: languageSchema,
  temporal_class: temporalClassSchema,
});

/**
 * RESERVED — written back by the (future) Content-Generation agent after it executes a brief.
 * EMPTY now, but reserved on the contract so the learning loop closes later: the Creative Head reads
 * past briefs + this subjective execution analysis to decide what to make next.
 */
export const briefExecutionSchema = z.object({
  // The Content Director's work-table lifecycle (CD-10/11): pending(staged) → expanding →
  // dispatched → done | partial | failed. 'generating' kept for the gen agent's sub-state.
  status: z.enum(['pending', 'expanding', 'dispatched', 'generating', 'done', 'partial', 'failed']),
  generated_asset_ids: z.array(z.string()).default([]),
  agent_analysis: z.string().default(''), // the gen agent's SUBJECTIVE analysis of the generation
  outcome: z
    .object({ forwards: z.number().optional(), shares: z.number().optional() })
    .optional(), // distribution feedback — much later
});

export const contentBriefSchema = z.object({
  schema_version: z.number().default(BRIEF_SCHEMA_VERSION),
  brief_id: z.string(),
  run_id: z.string(),
  status: z.enum(['proposed', 'approved']), // 'approved' immediately in autonomous mode

  // WHAT to make — explicit + machine-validatable (vague fields make generators improvise)
  theme: z.string(),
  creative_direction: z.string(),
  count: z.number().int().positive(),
  modality: z.enum(['image', 'image+greeting']),
  // The shape every asset is generated in (decided here, honoured at generation time — never cropped).
  // Single surface for now: a full-screen vertical reel for the mobile feed.
  form_factor: formFactorSchema.default('feed_reel'),
  languages: z.array(languageSchema).min(1),
  // Text overlay (the inspirational line / greeting). TYPOGRAPHY is a first-class engagement lever:
  // the font must suit the script (Devanagari vs Latin), the emotional register, and the cohort.
  text_overlay: z
    .object({
      enabled: z.boolean(),
      tone: z.string(),
      sample: z.string().optional(),
      typography: z
        .object({
          // Font family/token, ideally chosen from the global strategy font taxonomy.
          font: z.string(),
          // Per-script overrides when one brief renders multiple scripts (e.g. Devanagari + Latin).
          font_by_script: z.record(z.enum(['deva', 'latin']), z.string()).optional(),
          weight: z.string().optional(), // e.g. 'regular' | 'semibold' | '600'
          rationale: z.string().optional(), // why this font fits the script + cohort + emotion
        })
        .optional(),
    })
    .optional(),

  // DIVERSITY / FORWARD intent — the north star, explicit on every brief
  intent: z.enum(['consistency', 'novelty']),
  variety_axes: varietyAxesSchema,
  forward_hypothesis: z.string(), // why this will get forwarded (which share-driver), grounded

  // GEOGRAPHY + WHEN
  geo_targeting: geoTargetingSchema,
  temporal_class: temporalClassSchema,
  occasion: z
    .object({ event_id: z.string(), event_name: z.string() })
    .nullable(), // null ⇒ evergreen/daily
  schedule: scheduleSchema,
  delivery: deliverySchema,

  // CONTRACT for downstream
  metadata_spec: metadataSpecSchema,
  style_tokens: z.string(), // 'brandbook@v1'
  quality_rubric: z.string(), // rubric ref + cultural-veto note
  rationale: z.string(), // human-readable "why this brief"
  grounding: z.object({
    calendar_event_ids: z.array(z.string()).default([]),
    research_sources: z.array(z.string()).default([]),
    past_brief_ids: z.array(z.string()).default([]),
  }),

  // RESERVED — filled by the execution agent later
  execution: briefExecutionSchema.optional(),
});

export type ContentBrief = z.infer<typeof contentBriefSchema>;
export type BriefExecution = z.infer<typeof briefExecutionSchema>;
export type GeoWindow = z.infer<typeof geoWindowSchema>;

/**
 * The Strategy artifact frontmatter — the founder-readable narrative a run emits alongside its
 * briefs (the briefs are the machine contracts; this is the "why"). Markdown body lives separately.
 */
export const strategyArtifactSchema = z.object({
  schema_version: z.number().default(BRIEF_SCHEMA_VERSION),
  kind: z.literal('content-strategy'),
  run_id: z.string(),
  generated_at: z.string(),
  autonomy: z.enum(['autonomous', 'proposes']),
  thesis: z.string(),
  brief_ids: z.array(z.string()),
  diversity: z.object({
    cohorts: z.array(z.string()).default([]),
    deities: z.array(z.string()).default([]),
    festivals: z.array(z.string()).default([]),
    regions: z.array(z.string()).default([]),
    languages: z.array(z.string()).default([]),
    intents: z.record(z.string(), z.number()).default({}), // consistency vs novelty counts
  }),
});

export type StrategyArtifact = z.infer<typeof strategyArtifactSchema>;
