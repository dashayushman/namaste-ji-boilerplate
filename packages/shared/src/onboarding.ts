/**
 * The Onboarding Signals contract — everything the app knows about a brand-new user
 * (docs/console/FEED-LAB.md §6.1, FL-10).
 *
 * The real funnel is deliberately thin: phone OTP → language (optional, skippable) → deity
 * (optional, skippable). This schema is consumed by BOTH the (future) real onboarding flow and
 * the Feed Lab's persona builder — the same isomorphism principle as `rank()` (FL-1), applied
 * to the user. Build personas from this schema, never from ad-hoc Lab fields; a missing
 * optional field IS the "user skipped this step" state, so cold-start permutations
 * (± language, ± deity, ± geo) are just presence/absence here.
 *
 * Even a skipped-everything user is not a blank slate: country, device locale and signup time
 * are always on, and `coldStartVector()` (in @karkhana/feed) turns them into the context
 * floor (DS-12).
 */
import { z } from 'zod';
import { languageSchema } from './brief';

/** Current onboarding contract version. Bump on incompatible changes. */
export const ONBOARDING_SCHEMA_VERSION = 1;

export const onboardingSignalsSchema = z.object({
  schema_version: z.number().default(ONBOARDING_SCHEMA_VERSION),

  // Always present — server-side context, no user action required.
  signup_ts: z.string(), // ISO, server clock → time-of-day + calendar/festival proximity
  country: z.string().default('IN'), // phone country code
  channel: z.enum(['sms', 'whatsapp']).optional(), // OTP transport (a weak cohort hint)

  // Always-on implicit signals (absent only if collection failed).
  region: z.string().optional(), // ISO-3166-2 from IP geo (state); do NOT derive from phone circle
  device_locale: z.string().optional(), // BCP-47 Android locale — a strong implicit language hint

  // The two optional onboarding steps. Absent = the user skipped the step.
  language: languageSchema.optional(),
  deity: z.string().optional(),
});
export type OnboardingSignals = z.infer<typeof onboardingSignalsSchema>;

/**
 * Resolve the language the feed should assume: the explicit choice wins; otherwise fall back
 * to the device locale ('hi-*' → hi, everything else → en — Hinglish is never inferred, only
 * chosen). Shared so real onboarding and the Lab infer identically.
 */
export function inferLanguage(signals: OnboardingSignals): z.infer<typeof languageSchema> {
  if (signals.language) return signals.language;
  const locale = (signals.device_locale ?? '').toLowerCase();
  return locale.startsWith('hi') ? 'hi' : 'en';
}
