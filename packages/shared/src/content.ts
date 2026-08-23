/**
 * The Content Production contracts — the shapes that flow through the execution plane after a
 * brief: the SHOT (one single-asset job), the CONTENT ASSET (a produced piece), and the BATCH
 * records (OpenAI Batch API jobs). See docs/CONTENT-PRODUCTION.md.
 *
 * SINGLE SOURCE OF TRUTH for the boundary between the Content Director (emits shots), the Content
 * Creator (produces assets), the batch poller, and Heimdall. Like the brief (see ./brief), these
 * are VERSIONED contracts persisted as a JSON `payload` with only query-critical fields promoted to
 * indexed D1 columns — so the shape can evolve with no migration. Consumers branch on
 * `schema_version`; bump CONTENT_SCHEMA_VERSION on an incompatible change.
 */
import { z } from 'zod';
import { languageSchema, temporalClassSchema, varietyAxesSchema, metadataSpecSchema, formFactorSchema, type FormFactor } from './brief';

/** Current content-contract version. Bump on incompatible changes. */
export const CONTENT_SCHEMA_VERSION = 2;

/**
 * FORM-FACTOR production spec — maps each form factor to the size the image model GENERATES at (so the
 * master is born in the right shape; we never crop). `gen_size` is an OpenAI gpt-image-1 supported size;
 * `1024x1536` is its portrait max — the closest native shape to a 9:16 reel. Add families here, not in
 * the brief contract. `resolveGenSize` is what the Director stamps onto a shot and the Creator renders at.
 */
export const FORM_FACTOR = {
  feed_reel: { aspect: '9:16', label: 'Feed reel', gen_size: '1024x1536' },
} as const satisfies Record<FormFactor, { aspect: string; label: string; gen_size: string }>;

export function resolveGenSize(formFactor: FormFactor): string {
  return FORM_FACTOR[formFactor]?.gen_size ?? FORM_FACTOR.feed_reel.gen_size;
}

/**
 * Media family of a produced asset. Image only for now; the rest are reserved so the spine (queue,
 * lifecycle, eval, staging, publish) stays content-type-agnostic — a new family = a new RendererPort
 * impl, no schema change (docs CD-9).
 */
export const contentTypeSchema = z.enum(['image', 'video', 'audio', 'image+audio']);
export type ContentType = z.infer<typeof contentTypeSchema>;

/**
 * The ONE lifecycle a piece walks (docs/CONTENT-PRODUCTION.md §6). A `shot` carries the early
 * states (through `rendered`); once produced it becomes a `content_asset` that carries the rest.
 * One enum (not two) keeps the state machine single + legible.
 *  - drafted/queued        — expanded by the Director, awaiting generation
 *  - gen_batched           — in an OpenAI image batch (~24h)
 *  - rendered              — image stored + optimized + captioned; embedding pending
 *  - embed_batched         — in an OpenAI embedding batch (~24h)
 *  - staged                — quarantined, NOT live; ready for QA
 *  - eval_pending…scored   — Heimdall (async, sampled)
 *  - flagged/human_review  — exception path
 *  - published/unpublished — the gated publish step + rollback
 *  - failed/rejected       — terminal error / discarded
 */
export const contentStatusSchema = z.enum([
  'drafted', 'queued', 'gen_batched', 'rendered', 'embed_batched', 'staged',
  'eval_pending', 'evaluating', 'scored', 'flagged', 'human_review',
  'published', 'unpublished', 'failed', 'rejected',
]);
export type ContentStatus = z.infer<typeof contentStatusSchema>;

/** Where a shot's prompt routes for generation — the renderer + model + acquisition mode (CD-12). */
export const modelRouteSchema = z.object({
  provider: z.string().default('openai'), // routed via AI Gateway (sync) or direct Batch (volume)
  model: z.string(), // e.g. 'gpt-image-1'
  mode: z.enum(['sync', 'batch']), // sync = samples/spikes; batch = volume (docs §5.1)
  params: z.record(z.string(), z.unknown()).optional(), // size, quality, etc.
});

/**
 * Publish-ready copy the Content Director AUTHORS during shot expansion (docs §5.4/§10) — caption,
 * alt-text, a shareable forward message (the north star), descriptive tags, and SEO. Generated in the
 * SAME LLM call that writes the prompt (no separate VLM pass — CD efficiency); the Creator copies it onto
 * the produced asset verbatim. All optional: the deterministic fallback expansion path omits it.
 */
export const authoredMetaSchema = z.object({
  caption: z.record(z.string(), z.string()).optional(),      // per-language (key = language code)
  alt_text: z.string().optional(),
  forward_text: z.record(z.string(), z.string()).optional(), // per-language WhatsApp-forward copy
  tags: z.array(z.string()).optional(),                      // descriptive tags beyond the variety cell
  seo: z.object({ title: z.string(), description: z.string() }).partial().optional(),
});
export type AuthoredMeta = z.infer<typeof authoredMetaSchema>;

/**
 * A SHOT — one fully-resolved single-asset generation job, the unit that flows through the queue /
 * batch. The Content Director explodes a brief into many of these (docs §2). `shot_id` is
 * DETERMINISTIC (hash of brief+cell+seq) so batch redelivery never double-bills (idempotency, §2.2).
 */
export const shotSchema = z.object({
  schema_version: z.number().default(CONTENT_SCHEMA_VERSION),
  shot_id: z.string(), // deterministic
  brief_id: z.string(),
  batch_id: z.string(), // the content batch this shot belongs to
  seq: z.number().int().nonnegative(), // index within the batch (feeds the deterministic id)
  content_type: contentTypeSchema,
  status: contentStatusSchema,
  // The shape this shot is generated in (stamped from the brief). The Creator resolves it to the
  // image model's generation size via resolveGenSize — generated in-shape, never cropped.
  form_factor: formFactorSchema.default('feed_reel'),

  // WHAT to render — fully resolved (no strategy context needed downstream)
  prompt: z.string(),
  negative_prompt: z.string().optional(), // seeded from Heimdall's failure library (§12.6)
  language: languageSchema,
  variety_cell: varietyAxesSchema, // the diversity coordinates this shot fills
  metadata_spec: metadataSpecSchema, // the attribute tags the produced asset MUST carry
  authored_meta: authoredMetaSchema.optional(), // caption/alt/forward_text/SEO authored at expansion (§5.4/§10)

  // CONTRACT refs + routing
  style_tokens: z.string(), // 'brandbook@vN'
  quality_rubric_ref: z.string(),
  guardrails_ref: z.string().optional(), // cultural-correctness checklist version (feed-forward)
  model_route: modelRouteSchema,
  dedup_hash: z.string().optional(), // pre-spend dedup/MMR against the catalog (§2.1)
  cost_budget_cents: z.number().nonnegative().optional(),

  attempt: z.number().int().nonnegative().default(0), // retry counter (DLQ after K)
  error: z.string().optional(), // human-readable failure reason when status='failed' (surfaced in the BO)
  error_at: z.string().optional(), // ISO/SQL timestamp of the LAST failure — the BO shows "failed <ago>"
});
export type Shot = z.infer<typeof shotSchema>;

/** A delivery derivative of a master asset (CF Images variant) — docs §8. */
export const assetVariantSchema = z.object({
  name: z.string(), // 'feed-square' | 'status-portrait' | 'thumb' …
  r2_key: z.string(),
  format: z.enum(['avif', 'webp', 'jpeg']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
});

/** SEO / rich metadata carried per asset (docs §10). Caption doubles as embedding text (CD-13). */
export const assetMetadataSchema = z.object({
  caption: z.record(z.string(), z.string()).default({}), // per-language (key = language code)
  alt_text: z.string().optional(),
  forward_text: z.record(z.string(), z.string()).optional(), // per-language WhatsApp-forward copy (north star)
  tags: z.array(z.string()).default([]),
  attributes: metadataSpecSchema.optional(), // style/motif/palette/deity/… (write-contract)
  seo: z.object({ title: z.string(), description: z.string() }).partial().optional(),
  temporal_class: temporalClassSchema.optional(),
});

/**
 * A CONTENT ASSET — a produced, post-processed piece in the catalog (the system of record).
 * Written by the Content Creator at stage time; the JSON `payload` (metadata) is evolvable.
 */
export const contentAssetSchema = z.object({
  schema_version: z.number().default(CONTENT_SCHEMA_VERSION),
  content_id: z.string(),
  brief_id: z.string(),
  batch_id: z.string(),
  shot_id: z.string(),
  content_type: contentTypeSchema,
  status: contentStatusSchema,
  is_sample: z.boolean().default(false), // sync sample-set probes (quarantine-discarded unless promoted)

  // STORAGE
  r2_master_key: z.string(), // lossless master
  variants: z.array(assetVariantSchema).default([]),
  placeholder: z.string().optional(), // BlurHash/ThumbHash (LQIP)

  // RECOMMENDER — provenance is recorded so a model swap is detectable + re-embeddable (CD-16).
  embedding_id: z.string().nullable().default(null), // Vectorize id; null until embedded
  embedding_dim: z.number().int().positive().nullable().default(null),
  embedding_model: z.string().nullable().default(null), // which model/space this vector is in

  // PROVENANCE + COST
  model_route: modelRouteSchema,
  cost_cents: z.number().nonnegative().default(0),

  metadata: assetMetadataSchema,
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type ContentAsset = z.infer<typeof contentAssetSchema>;
export type AssetVariant = z.infer<typeof assetVariantSchema>;
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

/** Which OpenAI Batch phase a batch record represents (docs §5.2). */
export const batchPhaseSchema = z.enum(['image', 'embed']);
export type BatchPhase = z.infer<typeof batchPhaseSchema>;

/**
 * Local + OpenAI batch status. `assembling` is ours (building the JSONL before submit); the rest
 * mirror the OpenAI Batch lifecycle (confirmed: validating→in_progress→finalizing→completed, plus
 * failed/expired/cancelling/cancelled). Per-request failures land in `error_file_id` (docs §5.2).
 */
export const batchStatusSchema = z.enum([
  'assembling', 'submitted', 'validating', 'in_progress', 'finalizing',
  'completed', 'expired', 'failed', 'cancelling', 'cancelled',
]);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

/**
 * A BATCH RECORD — the poller's work-table row for one OpenAI batch job (image or embed phase).
 * State lives in D1 + a Cron poller, NOT a sleeping Workflow (docs §5.2, CD-12).
 */
export const batchRecordSchema = z.object({
  schema_version: z.number().default(CONTENT_SCHEMA_VERSION),
  id: z.string(), // our id
  content_batch_id: z.string(), // the content batch being generated
  phase: batchPhaseSchema,
  status: batchStatusSchema,

  openai_batch_id: z.string().nullable().default(null), // null until submitted
  input_file_id: z.string().nullable().default(null),
  output_file_id: z.string().nullable().default(null),
  error_file_id: z.string().nullable().default(null),

  // members keyed by custom_id: shot_id (image phase) or content_id (embed phase)
  custom_ids: z.array(z.string()).default([]),
  request_count: z.number().int().nonnegative().default(0),
  completed_count: z.number().int().nonnegative().default(0),
  failed_count: z.number().int().nonnegative().default(0),

  completion_window: z.literal('24h').default('24h'), // OpenAI: 24h only (confirmed)
  submitted_at: z.string().nullable().default(null),
  last_polled_at: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type BatchRecord = z.infer<typeof batchRecordSchema>;
