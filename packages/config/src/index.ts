/**
 * @namaste-ji/config
 *
 * KV-backed runtime config for all agents and services.
 *
 * Design contract:
 *   - Secrets (API keys, credentials) NEVER live here — those go in Secrets Store / .dev.vars
 *   - Everything else that an operator might want to tune lives here:
 *     model IDs, step budgets, thresholds, feature flags, agent parameters
 *   - Defaults are hardcoded in each consumer — the system never hard-fails on a missing KV key
 *   - KV is the live source; manifest.yaml / config/defaults/*.json document the schema + defaults
 *
 * Key namespacing:
 *   agent:{agent-id}     — per-agent config object (EventsCalendarConfig, etc.)
 *   global:{key}         — cross-agent config (shared model defaults, feature flags)
 *   feature:{flag}       — boolean feature flags
 */

// ── Core types ────────────────────────────────────────────────────────────────

export type ConfigKey =
  | `agent:${string}`
  | `global:${string}`
  | `feature:${string}`;

export interface ConfigEntry {
  key: string;
  value: unknown;
  updated_at?: string;
}

// ── Store abstraction ─────────────────────────────────────────────────────────

export interface ConfigStore {
  get<T>(key: ConfigKey): Promise<T | null>;
  set<T>(key: ConfigKey, value: T): Promise<void>;
  delete(key: ConfigKey): Promise<void>;
  list(prefix?: string): Promise<ConfigEntry[]>;
}

export function createKVConfigStore(kv: KVNamespace): ConfigStore {
  return {
    async get<T>(key: ConfigKey): Promise<T | null> {
      const raw = await kv.get(key, 'text');
      if (!raw) return null;
      return JSON.parse(raw) as T;
    },
    async set<T>(key: ConfigKey, value: T): Promise<void> {
      await kv.put(key, JSON.stringify(value));
    },
    async delete(key: ConfigKey): Promise<void> {
      await kv.delete(key);
    },
    async list(prefix = ''): Promise<ConfigEntry[]> {
      const result = await kv.list({ prefix });
      const entries = await Promise.all(
        result.keys.map(async (k) => {
          const raw = await kv.get(k.name, 'text');
          return {
            key: k.name,
            value: raw ? JSON.parse(raw) : null,
          };
        })
      );
      return entries;
    },
  };
}

// ── Typed config resolution ───────────────────────────────────────────────────
// Merges KV overrides onto hardcoded defaults. Partial overrides are fine —
// only the keys present in KV replace their defaults.

export async function getConfig<T extends object>(
  store: ConfigStore | undefined | null,
  key: ConfigKey,
  defaults: T
): Promise<T> {
  try {
    if (store) {
      const override = await store.get<Partial<T>>(key);
      if (override && typeof override === 'object') {
        return { ...defaults, ...override };
      }
    }
  } catch (e) {
    console.warn(`[config] KV read failed for "${key}", using defaults:`, e);
  }
  return { ...defaults };
}

// ── Per-agent config schemas ──────────────────────────────────────────────────
// Each agent defines its own typed config interface + defaults here.
// KV key: agent:{agent-id}

// ── Model provider types ──────────────────────────────────────────────────────

/**
 * Supported LLM providers.
 *
 * anthropic   → Anthropic API, routed through CF AI Gateway
 * openai      → OpenAI API, routed through CF AI Gateway
 * workers-ai  → Cloudflare Workers AI, routed through CF AI Gateway
 * sarvam      → Sarvam AI (India-hosted, Indic-tuned; OpenAI-compatible Chat Completions). Routed
 *               through the gateway's `sarvam` Custom Provider at
 *               `${ai_gateway_base_url}/custom-sarvam/{v1|v2}`. Key = SARVAM_API_KEY (pass-through,
 *               never BYOK — undocumented for custom providers). Text-only (no vision roles).
 * custom       → A self-hosted / unsupported OpenAI-compatible model registered as an
 *               AI Gateway "Custom Provider". Routed through the gateway at
 *               `${ai_gateway_base_url}/custom-{custom_slug}/v1` — same observability as
 *               the cloud providers. This is how the local llama.cpp (behind a Cloudflare
 *               Tunnel) is reached, so local mirrors staging/prod routing exactly.
 * local       → Any OpenAI-compatible server reached DIRECTLY (no gateway). Escape hatch
 *               for when you don't want a tunnel/gateway. Set LOCAL_LLM_URL to the server.
 */
export type LLMProvider = 'anthropic' | 'openai' | 'workers-ai' | 'sarvam' | 'custom' | 'local';

/**
 * Generation parameters for a model call. Provider-agnostic common params map 1:1 to the Vercel
 * AI SDK; anything provider-specific (e.g. OpenAI `reasoningEffort`, `maxCompletionTokens`,
 * `textVerbosity`) goes under `provider_options`, namespaced by provider, so you can control ANY
 * parameter from config without code changes and without risking the wrong param for the model.
 * Set at the agent top level (default for every role) and/or per role (overrides, shallow-merged).
 */
export interface ModelParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  /** Hard cap on output tokens. The SDK maps this to the right field per model
   *  (e.g. `max_completion_tokens` for OpenAI reasoning models like gpt-5*). */
  max_output_tokens?: number;
  stop_sequences?: string[];
  seed?: number;
  /**
   * Provider-specific options passed straight through to the AI SDK `providerOptions`, keyed by
   * provider namespace. Example: { "openai": { "reasoningEffort": "low", "textVerbosity": "low" } }.
   * Use this for any param not in the common set above. Replaces (not merges) on per-role override.
   */
  provider_options?: Record<string, Record<string, unknown>>;
}

/**
 * Per-role model override. A partial selection layered onto an agent's top-level
 * provider/model_id default — only the fields present override the default. This is how one
 * agent can run different models (and params) for different tasks (e.g. a strong orchestrator +
 * a cheap research/STM-writer model) without code changes. Switch in KV, takes effect next run.
 */
export interface ModelRoleConfig {
  provider?: LLMProvider;
  model_id?: string;
  /** Custom Provider slug — only relevant when provider === 'custom'. */
  custom_slug?: string;
  /** Per-role generation params; shallow-merged onto the agent's top-level `params`. */
  params?: ModelParams;
}

/** Resolved model config — everything resolveModel() needs, no raw env access. */
export interface ResolvedModelConfig {
  provider: LLMProvider;
  model_id: string;
  /** CF AI Gateway base URL: https://gateway.ai.cloudflare.com/v1/{account}/{gateway} */
  ai_gateway_base_url: string;
  /** Custom Provider slug (provider === 'custom'); routed at `${gateway}/custom-{slug}/v1` */
  custom_slug: string;
  /** Local server URL (only used when provider === 'local') */
  local_llm_url: string;
  /** API key for the chosen provider (resolved from secrets at runtime). Empty when byok=true. */
  api_key: string;
  /**
   * BYOK (Bring Your Own Keys): the provider key is stored IN the AI Gateway, not in the worker.
   * When true, buildModel sends `cf-aig-authorization: Bearer {aig_authorization}` (the gateway's
   * own auth token) instead of the provider key, and the gateway injects the stored key.
   * Requires ai_gateway_base_url. See https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
   */
  byok: boolean;
  /** AI Gateway authentication token for the `cf-aig-authorization` header (only used when byok). */
  aig_authorization: string;
  /** Non-default stored-key alias; sent as `cf-aig-byok-alias`. Omit/empty/`default` = the default key. */
  byok_alias: string;
  /**
   * Which OpenAI HTTP API to use for provider === 'openai' (cloud OpenAI only). 'responses' is
   * OpenAI's recommended default and is REQUIRED to combine reasoning_effort with tool-calling
   * (reasoning models like gpt-5*). 'chat' = legacy Chat Completions. The compatible servers
   * (workers-ai/custom/local) always use Chat Completions regardless of this.
   */
  openai_api: 'chat' | 'responses';
  /**
   * Sarvam API version for provider === 'sarvam': 'v1' (default; sarvam-105b) or 'v2' (open-weight
   * glm5.2 / gemma4 — beta-gated per Sarvam account). Ignored for other providers.
   */
  sarvam_api: 'v1' | 'v2';
}

// ── Retry / backoff for AI calls ──────────────────────────────────────────────

/**
 * Exponential-backoff retry policy applied to EVERY LLM/AI call the kernel makes (orchestrator,
 * STM-writer, subagents) plus agent-level model calls. Transient failures — 429 rate-limits and
 * 5xx provider errors (e.g. OpenAI's generic "An error occurred while processing your request") —
 * are retried with jittered exponential backoff instead of failing the whole run. Tunable per agent
 * via KV config (`retry`); the kernel falls back to DEFAULT_RETRY when unset, so all agents benefit.
 */
export interface RetryConfig {
  /** Retries AFTER the first attempt (so total attempts = max_retries + 1). */
  max_retries: number;
  /** Base delay before the first retry, in ms. */
  initial_delay_ms: number;
  /** Cap on any single backoff delay, in ms. */
  max_delay_ms: number;
  /** Exponential growth factor between retries (delay = initial * factor^attempt). */
  factor: number;
  /** Apply random jitter (50–100% of the computed delay) to avoid thundering-herd. Default true. */
  jitter?: boolean;
}

export const DEFAULT_RETRY: RetryConfig = {
  max_retries: 10,
  initial_delay_ms: 2000,
  max_delay_ms: 60000,
  factor: 2,
  jitter: true,
};

// ── Global config ─────────────────────────────────────────────────────────────

/** Global config shared across all agents. KV key: global:defaults */
export interface GlobalConfig {
  /**
   * CF AI Gateway base URL. All cloud provider calls route through this.
   * Format: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_name}
   * Changing this here switches the gateway for every agent on next run.
   */
  ai_gateway_base_url: string;
  /** Fallback model + provider if an agent doesn't specify one */
  default_provider: LLMProvider;
  default_model_id: string;
}

// Fallback = the cheap OpenAI mini tier, matching the per-agent defaults (models come from KV per
// environment — this only applies when global:defaults is unset). BYOK is a per-agent setting.
export const GLOBAL_DEFAULTS: GlobalConfig = {
  ai_gateway_base_url: '',  // must be set in KV for staging/prod
  default_provider: 'openai',
  default_model_id: 'gpt-5.4-mini',
};

// ── Per-agent config schemas ──────────────────────────────────────────────────

/**
 * Model roles for the Events Calendar Agent — the distinct LLM call sites a run makes.
 * Any role omitted from `models` falls back to the agent's top-level provider/model_id.
 *   orchestrator        — the main decision loop (benefits from a stronger model)
 *   stm_writer          — rewrites the orchestrator's working memory each turn (cheap is fine)
 *   research            — the web-research subagent's inner loop (high call volume; cheap pays off)
 *   research_stm_writer — the research subagent's working-memory rewrites (cheap is fine)
 *   playbook_writer     — rewrites the Markdown LTM playbook at run end (cheap is fine)
 */
export type EventsCalendarModelRole =
  | 'orchestrator'
  | 'stm_writer'
  | 'research'
  | 'research_stm_writer'
  | 'playbook_writer';

/** Events Calendar Agent config. KV key: agent:events-calendar */
export interface EventsCalendarConfig {
  /** Default LLM provider for every role. Switch provider+model here — no redeploy needed. */
  provider: LLMProvider;
  model_id: string;
  /** AI Gateway Custom Provider slug — only used when provider === 'custom' (e.g. 'local-llama') */
  custom_slug?: string;
  /**
   * BYOK: store the provider key in the AI Gateway instead of the worker. When true, the worker
   * sends the gateway's `cf-aig-authorization` token (env CLOUDFLARE_AI_GATEWAY_TOKEN) and the gateway
   * injects the stored provider key. Requires a gateway base URL (global:defaults). Applies to
   * all roles; if a role overrides the provider, that provider's key must also be stored.
   */
  byok?: boolean;
  /** Non-default BYOK key alias (sent as `cf-aig-byok-alias`). Omit to use the gateway's default key. */
  byok_alias?: string;
  /**
   * OpenAI HTTP API for provider === 'openai': 'responses' (default; needed for reasoning_effort
   * + tools on gpt-5* models) or 'chat' (legacy Chat Completions). Ignored for other providers.
   */
  openai_api?: 'chat' | 'responses';
  /** Sarvam API version for provider === 'sarvam': 'v1' (default) or 'v2' (beta). */
  sarvam_api?: 'v1' | 'v2';
  /** Default generation params for EVERY role (temperature, token caps, provider_options, …). */
  params?: ModelParams;
  /**
   * Per-role model overrides. Omit to use the top-level default for every role; set a role to
   * run a different model (and/or params) just for that task (e.g. a cheap model for research).
   */
  models?: Partial<Record<EventsCalendarModelRole, ModelRoleConfig>>;
  /** Minimum average confidence before stopping research early */
  confidence_min: number;
  /** How many months ahead to research */
  calendar_months_ahead: number;
  /** Research intensity hint passed to the orchestrator prompt */
  research_depth: 'light' | 'standard' | 'deep';
}

export const EVENTS_CALENDAR_DEFAULTS: EventsCalendarConfig = {
  provider: 'openai',
  model_id: 'gpt-5.4-mini', // cheap fallback (local); staging KV overrides to gpt-5.5
  byok: true,
  byok_alias: 'namaste-ji-openai',
  openai_api: 'responses', // reasoning_effort + verbosity + tool-calling on gpt-5*
  params: { provider_options: { openai: { reasoningEffort: 'low', textVerbosity: 'low' } } },
  confidence_min: 0.75,
  calendar_months_ahead: 12,
  research_depth: 'standard',
};

// ── Creative Head / VP Content agent ──────────────────────────────────────────

/**
 * Model roles for the Creative Head — the distinct LLM call sites a run makes.
 * Any role omitted from `models` falls back to the agent's top-level provider/model_id.
 *   orchestrator        — the VP decision loop (benefits from a stronger model)
 *   stm_writer          — rewrites the orchestrator's working memory each turn (cheap is fine)
 *   research            — the web-research subagent's inner loop (trend + iconography validation)
 *   research_stm_writer — the research subagent's working-memory rewrites (cheap is fine)
 *   playbook_writer     — rewrites the long-term Markdown playbook at end of run (cheap is fine)
 */
export type CreativeHeadModelRole =
  | 'orchestrator'
  | 'stm_writer'
  | 'research'
  | 'research_stm_writer'
  | 'playbook_writer'
  // Multimodal model for analyze_image (vision). MUST be a vision-capable model — if you override
  // the top-level model to a text-only one, set this role to a multimodal model explicitly.
  | 'vision';

/** Creative Head / VP Content config. KV key: agent:creative-head */
export interface CreativeHeadConfig {
  /** Default LLM provider for every role. Switch provider+model here — no redeploy needed. */
  provider: LLMProvider;
  model_id: string;
  /** AI Gateway Custom Provider slug — only used when provider === 'custom'. */
  custom_slug?: string;
  /** BYOK: store the provider key in the AI Gateway instead of the worker (see EventsCalendarConfig). */
  byok?: boolean;
  byok_alias?: string;
  /** OpenAI HTTP API for provider === 'openai': 'responses' (default) or 'chat'. */
  openai_api?: 'chat' | 'responses';
  /** Sarvam API version for provider === 'sarvam': 'v1' (default) or 'v2' (beta). */
  sarvam_api?: 'v1' | 'v2';
  /** Default generation params for EVERY role. */
  params?: ModelParams;
  /** Per-role model overrides. */
  models?: Partial<Record<CreativeHeadModelRole, ModelRoleConfig>>;

  /**
   * Autonomy mode. 'autonomous' = briefs are written 'approved' with NO human gate (the agent runs
   * the whole loop unattended). 'proposes' = briefs land 'proposed' for founder approval in the BO.
   */
  autonomy: 'autonomous' | 'proposes';
  /** How many months ahead to plan content for (drives which events/occasions are in scope). */
  planning_horizon_months: number;
  /** Research intensity hint passed to the research subagent (its inner-loop depth). */
  research_depth: 'light' | 'standard' | 'deep';
  /** Minimum number of briefs a run should emit before the coverage/diversity gate allows finish. */
  brief_floor: number;
  /** Min confidence on load-bearing (cultural-veto-adjacent) claims before shipping a brief. */
  confidence_min: number;
  /** Retry/backoff policy for all AI calls this agent makes. Omit to use DEFAULT_RETRY. */
  retry?: RetryConfig;
}

// Models come from CONFIG per environment — NEVER hardcoded in logic. These DEFAULTS are the cheap
// fallback (used locally / when KV is unset): gpt-5.4-mini for every role, low reasoning + low verbosity.
// Staging KV overrides to the flagship gpt-5.5 (see config/defaults/agent-creative-head.json + the
// staging KV). openai_api='responses' is what lets reasoning_effort + verbosity ride with tool-calling.
const CH_MODEL = { provider: 'openai' as const, model_id: 'gpt-5.4-mini' };
const REASON_LOW_VERBOSE_LOW: ModelParams = { provider_options: { openai: { reasoningEffort: 'low', textVerbosity: 'low' } } };

export const CREATIVE_HEAD_DEFAULTS: CreativeHeadConfig = {
  provider: 'openai',
  model_id: 'gpt-5.4-mini',
  byok: true,
  byok_alias: 'namaste-ji-openai',
  openai_api: 'responses', // required for reasoning_effort + tool-calling on gpt-5* models
  autonomy: 'proposes', // safe default; flip to 'autonomous' in KV when trusted
  planning_horizon_months: 3,
  research_depth: 'standard',
  brief_floor: 6,
  confidence_min: 0.75,
  retry: DEFAULT_RETRY,
  params: REASON_LOW_VERBOSE_LOW, // every role: low reasoning effort + low verbosity
  models: {
    orchestrator: CH_MODEL,
    research: CH_MODEL,
    vision: CH_MODEL,
    stm_writer: CH_MODEL,
    research_stm_writer: CH_MODEL,
    playbook_writer: CH_MODEL,
  },
};

/**
 * Global content strategy — the interests taxonomy the Creative Head plans against. KV key:
 * global:strategy. This is the "global strategy content" the agent weighs: which deities, festivals,
 * regions, languages and audience cohorts matter. Edited in the BO; documented in config/defaults.
 */
/**
 * An approved font for text overlays. Typography is a first-class engagement lever — the wrong font
 * for a script (or vibe) kills likability — so the agent picks from this curated, script-aware set.
 *   scripts: 'deva' (Devanagari, for hi) and/or 'latin' (for en / hi-Latn Hinglish).
 */
export interface FontToken {
  name: string;          // font family, e.g. 'Baloo 2' (must support its declared scripts)
  scripts: ('deva' | 'latin')[];
  vibe: string;          // when to reach for it, e.g. 'warm, friendly, brand default'
}

export interface GlobalStrategy {
  deities: string[];
  festivals: string[];
  /** ISO-3166-2 IN state codes (+ 'IN' for pan-India) we target. */
  regions: string[];
  /** Languages we generate for (mirrors @namaste-ji/shared LANGS). */
  languages: string[];
  audience_cohorts: string[];
  /** Approved, script-aware fonts the agent chooses from for any text overlay. */
  fonts: FontToken[];
  /** Free-text strategic direction / north-star notes for the VP to weigh. */
  north_star?: string;
}

export const GLOBAL_STRATEGY_DEFAULTS: GlobalStrategy = {
  deities: ['Ganesha', 'Shiva', 'Krishna', 'Lakshmi', 'Hanuman', 'Durga', 'Rama', 'Saraswati'],
  festivals: ['Diwali', 'Holi', 'Navratri', 'Ganesh Chaturthi', 'Janmashtami', 'Raksha Bandhan'],
  regions: ['IN', 'IN-UP', 'IN-MH', 'IN-DL', 'IN-RJ', 'IN-BR', 'IN-MP', 'IN-GJ'],
  languages: ['hi', 'en', 'hi-Latn'],
  audience_cohorts: ['senior', 'millennial', 'gen-z', 'all'],
  fonts: [
    { name: 'Baloo 2', scripts: ['deva', 'latin'], vibe: 'warm, friendly, rounded — brand default; works across cohorts' },
    { name: 'Mukta', scripts: ['deva', 'latin'], vibe: 'clean, highly legible — good for elders and dense blessings' },
    { name: 'Tiro Devanagari Hindi', scripts: ['deva'], vibe: 'traditional serif — devotional, scriptural gravitas' },
    { name: 'Rozha One', scripts: ['deva', 'latin'], vibe: 'elegant high-contrast display — festival hero lines' },
    { name: 'Kalam', scripts: ['deva', 'latin'], vibe: 'handwritten, personal — feels like a heartfelt note' },
    { name: 'Poppins', scripts: ['latin'], vibe: 'modern geometric — younger cohorts, Hinglish/English one-liners' },
    { name: 'Yatra One', scripts: ['deva', 'latin'], vibe: 'bold decorative display — bold festive greetings' },
  ],
  north_star: 'Maximize forwards. Diversity is the primary lever — amplify the recipe, not the dish.',
};

// ── Heimdall — the QA / evaluation plane (CONTENT-PRODUCTION.md §12) ──────────

/**
 * Model roles for Heimdall — the distinct LLM call sites an eval-run makes.
 *   metric — one call per (sampled asset × metric): scores the image against ONE Langfuse metric
 *            prompt. MUST be a vision-capable model (it sees the rendered asset).
 *   judge  — one call per sampled asset: integrates the metric results (+ the image) into the
 *            final ship/flag/veto verdict + rationale. MUST also be vision-capable.
 */
export type HeimdallModelRole = 'metric' | 'judge';

/** One metric in Heimdall's configurable metric set (§12.2/§12.3). The PROMPT lives in Langfuse
 * (`heimdall/metric-<name>`); this entry declares how the score is integrated: veto metrics gate
 * (never averaged — CP-4), weighted metrics fold into the composite. */
export interface HeimdallMetric {
  name: string;
  /** Composite weight (normalized over non-veto metrics at run time). Ignored when veto=true. */
  weight: number;
  /** Hard gate: verdict 'fail' ⇒ UNRELEASABLE, regardless of every other score. */
  veto?: boolean;
}

/** Heimdall config. KV key: agent:heimdall */
export interface HeimdallConfig {
  /**
   * Which engine runs the vision calls. 'model-port' (default) = the normal kernel ModelPort
   * (gateway + BYOK, provider/model below). 'workers-ai-binding' = the worker's native `env.AI`
   * binding running `workers_ai_model` — zero external quota (Workers AI bills to the CF
   * account), the escape hatch when the BYOK provider is out of quota. Flip in KV, no deploy.
   */
  engine?: 'model-port' | 'workers-ai-binding';
  /** Vision model for engine='workers-ai-binding' (must accept image input). */
  workers_ai_model?: string;
  /** Default LLM provider/model for every role. Must be vision-capable (both roles see images). */
  provider: LLMProvider;
  model_id: string;
  custom_slug?: string;
  /** BYOK: provider key stored in the AI Gateway (see EventsCalendarConfig). */
  byok?: boolean;
  byok_alias?: string;
  openai_api?: 'chat' | 'responses';
  /** Sarvam API version for provider === 'sarvam': 'v1' (default) or 'v2' (beta). */
  sarvam_api?: 'v1' | 'v2';
  /** Default generation params for EVERY role. */
  params?: ModelParams;
  /** Per-role model overrides. */
  models?: Partial<Record<HeimdallModelRole, ModelRoleConfig>>;

  /** The metric set — add/remove/re-weight metrics here + edit their prompts in Langfuse;
   * neither needs a deploy (CD-3). */
  metrics: HeimdallMetric[];
  /** Sampling (§12.4): Wilson-interval sizing on the fail/veto proportion. */
  target_confidence: number;   // e.g. 0.95
  target_margin: number;       // half-width, e.g. 0.10 → ±10%
  /** Expected fail/veto proportion used to size n (conservative 0.5 = max n). */
  expected_fail_rate: number;
  /** Hard cap on samples per run — the cost guard, whatever the CI math asks for. */
  max_sample: number;
  /** staleness_pct above this ⇒ the run shows STALE in the BO. */
  staleness_threshold: number;
  /** Composite below this ⇒ flagged for human review even without a veto. */
  flag_threshold: number;
  /** Which delivery variant is sent to the vision model ('feed-webp' balances fidelity vs tokens). */
  image_variant: string;
  /** Retry/backoff policy for all AI calls. Omit to use DEFAULT_RETRY. */
  retry?: RetryConfig;
}

const HD_MODEL = { provider: 'openai' as const, model_id: 'gpt-5.4-mini' };

export const HEIMDALL_DEFAULTS: HeimdallConfig = {
  engine: 'model-port',
  workers_ai_model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
  provider: 'openai',
  model_id: 'gpt-5.4-mini', // models come from KV per env — this is the cheap local fallback
  byok: true,
  byok_alias: 'namaste-ji-openai',
  openai_api: 'responses',
  params: { provider_options: { openai: { reasoningEffort: 'low', textVerbosity: 'low' } } },
  models: { metric: HD_MODEL, judge: HD_MODEL },
  metrics: [
    { name: 'cultural-correctness', weight: 0, veto: true },
    { name: 'safety', weight: 0, veto: true },
    { name: 'text-legibility', weight: 0.25 },
    { name: 'aesthetic-quality', weight: 0.25 },
    { name: 'forward-appeal', weight: 0.20 },
    { name: 'brand-fit', weight: 0.15 },
    { name: 'prompt-adherence', weight: 0.15 },
  ],
  target_confidence: 0.95,
  target_margin: 0.10,
  expected_fail_rate: 0.2,
  max_sample: 100,
  staleness_threshold: 0.2,
  flag_threshold: 60,
  image_variant: 'feed-webp',
  retry: DEFAULT_RETRY,
};
