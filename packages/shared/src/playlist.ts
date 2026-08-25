import { z } from 'zod';
import { languageSchema, temporalClassSchema } from './brief';

/**
 * The consumer feed serving contract (docs/FRONTEND.md §4, DISTRIBUTION §4/§7).
 *
 * v1 is served by consumer-api's simple candidates+seeded-shuffle feed; the future
 * rank() spine (@namaste-ji/feed, FL-1) replaces ONLY the ordering step behind this
 * same page shape — items are self-contained and the cursor is opaque, so the client
 * never changes.
 */
export const PLAYLIST_SCHEMA_VERSION = 1;

export const playlistImageSchema = z.object({
  /** Opaque URL (relative '/api/content/…' today; absolute CDN/Images later). */
  src: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.string().optional(),
  variants: z
    .array(
      z.object({
        name: z.string(), // 'feed-square' | 'status-portrait' | 'thumb' …
        src: z.string(),
        format: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
    )
    .default([]),
});

export const playlistItemSchema = z.object({
  content_id: z.string(),
  /** Per-language caption/forward text — the client picks the profile language. */
  caption: z.record(z.string(), z.string()).default({}),
  forward_text: z.record(z.string(), z.string()).optional(),
  alt_text: z.string().optional(),
  /** BlurHash/ThumbHash — inlined so placeholders render with zero layout shift. */
  blurhash: z.string().optional(),
  image: playlistImageSchema,
  facets: z
    .object({
      deity: z.string().optional(),
      theme: z.string().optional(),
      temporal_class: temporalClassSchema.optional(),
    })
    .default({}),
  created_at: z.string().optional(),
});

export const feedTabSchema = z.object({
  id: z.string(), // 'for-you' | 'fresh' | 'festival' | 'deity:<value>'
  kind: z.enum(['all', 'fresh', 'temporal', 'deity']),
  value: z.string().optional(),
  /** Per-language label; absent ⇒ the client's i18n knows the fixed ids. */
  label: z.record(z.string(), z.string()).optional(),
});

export const playlistPageSchema = z.object({
  schema_version: z.number().default(PLAYLIST_SCHEMA_VERSION),
  tab: z.string(),
  /** EV-5: minted per served page; the client echoes it on every event from this page.
   * Additive + optional — v1 clients ignore it, the page shape is otherwise unchanged. */
  request_id: z.string().optional(),
  items: z.array(playlistItemSchema),
  next_cursor: z.string().nullable(),
  generated_at: z.string(),
});

/** Consumer profile prefs (aligned with OnboardingSignals fields; own table, PII plane). */
export const consumerProfileSchema = z.object({
  language: languageSchema.optional(),
  deity: z.string().optional(),
});

export type PlaylistItem = z.infer<typeof playlistItemSchema>;
export type PlaylistPage = z.infer<typeof playlistPageSchema>;
export type FeedTab = z.infer<typeof feedTabSchema>;
export type ConsumerProfile = z.infer<typeof consumerProfileSchema>;
