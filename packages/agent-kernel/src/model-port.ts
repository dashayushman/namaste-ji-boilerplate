/**
 * ModelPort — the kernel's LLM-agnostic model layer (AGENT-PLATFORM.md BO-2).
 *
 * Every agent resolves + builds its model here. Provider + model come from KV config; all
 * cloud calls route through the CF AI Gateway (cost + observability), local dev can hit a
 * llama.cpp/Ollama server directly. Switching provider is config, not code.
 *
 *   anthropic  → Anthropic SDK  → AI Gateway /anthropic           → Anthropic API
 *   openai     → OpenAI SDK     → AI Gateway /openai              → OpenAI API
 *   workers-ai → OpenAI SDK     → AI Gateway /workers-ai/v1       → Workers AI
 *   sarvam     → OpenAI SDK     → AI Gateway /custom-sarvam/v1    → Sarvam AI (api.sarvam.ai)
 *   custom     → OpenAI SDK     → AI Gateway /custom-{slug}/v1    → self-hosted model
 *   local      → OpenAI SDK     → LOCAL_LLM_URL (direct, no gateway)
 *
 * When ai_gateway_base_url is empty, anthropic/openai connect directly to the provider — used
 * in local dev where the gateway HTTPS path is unavailable (e.g. cloudflared tunnel down).
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ResolvedModelConfig, LLMProvider, ModelRoleConfig, ModelParams } from '@karkhana/config';

/** AI SDK generation params (the subset of generateText/streamText options we map config to). */
export interface GenerateParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  seed?: number;
  // Structural match for the AI SDK's ProviderOptions (which isn't re-exported from `ai`). The
  // `any` leaf keeps the opaque per-provider passthrough assignable to its JSONValue leaves.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: Record<string, Record<string, any>>;
}

/**
 * Map config `ModelParams` (snake_case, provider-agnostic) to AI SDK `generateText` options
 * (camelCase). Only keys the operator actually set are emitted, so nothing unintended is sent.
 * Provider-specific params ride through `provider_options` → `providerOptions` untouched.
 */
export function toGenerateParams(p?: ModelParams): GenerateParams {
  if (!p) return {};
  const out: GenerateParams = {};
  if (p.temperature !== undefined) out.temperature = p.temperature;
  if (p.top_p !== undefined) out.topP = p.top_p;
  if (p.top_k !== undefined) out.topK = p.top_k;
  if (p.frequency_penalty !== undefined) out.frequencyPenalty = p.frequency_penalty;
  if (p.presence_penalty !== undefined) out.presencePenalty = p.presence_penalty;
  if (p.max_output_tokens !== undefined) out.maxOutputTokens = p.max_output_tokens;
  if (p.stop_sequences !== undefined) out.stopSequences = p.stop_sequences;
  if (p.seed !== undefined) out.seed = p.seed;
  // provider_options is an opaque per-provider passthrough; the AI SDK validates the leaf values.
  if (p.provider_options !== undefined) out.providerOptions = p.provider_options;
  return out;
}

/** Env bindings ModelPort reads to resolve provider secrets. */
export interface ModelPortEnv {
  ANTHROPIC_API_KEY?: SecretsStoreSecret | string;
  OPENAI_API_KEY?: SecretsStoreSecret | string;
  CF_AI_TOKEN?: SecretsStoreSecret | string;
  /** Sarvam AI key — pass-through `Authorization: Bearer` via the gateway `sarvam` Custom Provider. */
  SARVAM_API_KEY?: SecretsStoreSecret | string;
  /** AI Gateway auth token for the `cf-aig-authorization` header — used for BYOK / authenticated gateways. */
  CLOUDFLARE_AI_GATEWAY_TOKEN?: SecretsStoreSecret | string;
  LOCAL_LLM_URL?: string;
}

/** Resolve a value that may be a Secrets Store binding (.get()) or a plain string. */
const readSecret = (v: SecretsStoreSecret | string | undefined): Promise<string> =>
  v && typeof v === 'object' && 'get' in v ? v.get() : Promise.resolve((v as string) ?? '');

/**
 * Merge gateway headers onto the base request headers. An *authenticated* gateway needs
 * `cf-aig-authorization` on EVERY request routed through it (BYOK or pass-through key alike;
 * harmless on unauthenticated gateways), so it is sent whenever the token is available. With BYOK
 * the provider key additionally lives in the gateway, selected by the optional key alias.
 */
function withGatewayHeaders(cfg: ResolvedModelConfig, headers: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...headers };
  if (cfg.ai_gateway_base_url && cfg.aig_authorization) h['cf-aig-authorization'] = `Bearer ${cfg.aig_authorization}`;
  if (!cfg.byok) return h;
  if (!cfg.ai_gateway_base_url) throw new Error('[ModelPort] byok=true but ai_gateway_base_url is empty — BYOK requires the AI Gateway');
  if (!cfg.aig_authorization) throw new Error('[ModelPort] byok=true but CLOUDFLARE_AI_GATEWAY_TOKEN is empty — set the gateway auth token');
  if (cfg.byok_alias && cfg.byok_alias !== 'default') h['cf-aig-byok-alias'] = cfg.byok_alias;
  return h;
}

/**
 * A `fetch` that strips the provider auth headers (`authorization`, `x-api-key`) before the
 * request leaves the worker. Used for BYOK: the gateway injects the stored provider key, and a
 * passthrough auth header would otherwise reach the provider and 401 (the gateway forwards it
 * verbatim). We authenticate to the gateway via `cf-aig-authorization` instead.
 */
function byokFetch(): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.delete('x-api-key');
    return globalThis.fetch(input, { ...init, headers });
  }) as typeof globalThis.fetch;
}

/** Build a Vercel AI SDK LanguageModel from a resolved config. Pure — no I/O. */
export function buildModel(cfg: ResolvedModelConfig, headers: Record<string, string> = {}): LanguageModel {
  const { provider, model_id, ai_gateway_base_url, custom_slug, local_llm_url } = cfg;
  const h = withGatewayHeaders(cfg, headers);
  // With BYOK the gateway holds the provider key. The SDK still requires a non-empty apiKey to
  // build its auth header, so we pass a placeholder and strip that header via a custom fetch —
  // the gateway forwards the provider auth header verbatim, so a stray placeholder would 401.
  const api_key = cfg.byok ? 'byok' : cfg.api_key;
  const fetchImpl = cfg.byok ? byokFetch() : undefined;

  switch (provider) {
    case 'anthropic':
      return ai_gateway_base_url
        ? createAnthropic({ apiKey: api_key, baseURL: `${ai_gateway_base_url}/anthropic`, headers: h, fetch: fetchImpl })(model_id)
        : createAnthropic({ apiKey: api_key, headers: h, fetch: fetchImpl })(model_id);

    // Cloud OpenAI: default to the Responses API (`/v1/responses`) — OpenAI's recommended API and
    // the ONLY one that allows reasoning_effort together with tool-calling (gpt-5* reasoning
    // models). `openai_api: 'chat'` opts back to Chat Completions. The OpenAI-compatible servers
    // below (workers-ai/custom/local) implement only Chat Completions, so they always use `.chat()`.
    case 'openai': {
      const provider = ai_gateway_base_url
        ? createOpenAI({ apiKey: api_key, baseURL: `${ai_gateway_base_url}/openai`, headers: h, fetch: fetchImpl })
        : createOpenAI({ apiKey: api_key, headers: h, fetch: fetchImpl });
      return cfg.openai_api === 'chat' ? provider.chat(model_id) : provider.responses(model_id);
    }

    case 'workers-ai':
      return createOpenAI({ apiKey: api_key, baseURL: `${ai_gateway_base_url}/workers-ai/v1`, headers: h, fetch: fetchImpl }).chat(model_id);

    // Sarvam AI — India-hosted, OpenAI-compatible Chat Completions (sarvam-105b: tools + json_schema +
    // reasoning_effort; text-only). Reached through the gateway's `sarvam` Custom Provider (base
    // https://api.sarvam.ai) so it gets the same observability as the cloud providers. The key is
    // pass-through (`Authorization: Bearer`), never BYOK (resolveModelConfig forces byok=false —
    // BYOK is undocumented for custom providers). `sarvam_api` selects /v1 (sarvam-105b) or /v2
    // (open-weight glm5.2/gemma4, beta-gated). reasoning_effort rides via
    // provider_options.openai.reasoningEffort; OpenAI-only extras (verbosity) are tolerated upstream.
    case 'sarvam':
      if (!ai_gateway_base_url) throw new Error('[ModelPort] provider=sarvam but ai_gateway_base_url is empty — Sarvam is routed via the gateway Custom Provider');
      if (!api_key) throw new Error('[ModelPort] provider=sarvam but SARVAM_API_KEY is empty');
      return createOpenAI({ apiKey: api_key, baseURL: `${ai_gateway_base_url}/custom-sarvam/${cfg.sarvam_api}`, headers: h }).chat(model_id);

    case 'custom':
      if (!ai_gateway_base_url) throw new Error('[ModelPort] provider=custom but ai_gateway_base_url is empty');
      if (!custom_slug) throw new Error('[ModelPort] provider=custom but custom_slug is not set');
      return createOpenAI({ apiKey: api_key || 'no-key', baseURL: `${ai_gateway_base_url}/custom-${custom_slug}/v1`, headers: h, fetch: fetchImpl }).chat(model_id);

    case 'local':
      if (cfg.byok) throw new Error('[ModelPort] byok is not supported with provider=local (no gateway)');
      if (!local_llm_url) throw new Error('[ModelPort] provider=local but LOCAL_LLM_URL is not set');
      return createOpenAI({ apiKey: 'no-key', baseURL: local_llm_url }).chat(model_id);

    default:
      throw new Error(`[ModelPort] Unknown provider: ${provider as string}`);
  }
}

/**
 * Providers that only take TEXT input. Sarvam is an LLM-only pool member: it must never serve a
 * vision role (images in the prompt), and it is structurally unreachable from image generation
 * (RendererPort, content-creator) and embeddings (EmbeddingPort, Cohere) — those don't go through
 * ModelPort at all. Vision-role builders call `assertVisionCapable` so a KV misconfig fails fast at
 * run start with a clear message instead of a provider 400 mid-run.
 */
export const TEXT_ONLY_PROVIDERS: ReadonlySet<LLMProvider> = new Set<LLMProvider>(['sarvam']);

/** Throw if `provider` cannot take image input; `where` names the role for the error message. */
export function assertVisionCapable(provider: LLMProvider, where: string): void {
  if (TEXT_ONLY_PROVIDERS.has(provider)) {
    throw new Error(`[ModelPort] provider '${provider}' is text-only but ${where} needs a vision-capable model — point that role at a multimodal provider/model (e.g. models.<role> = { provider: 'openai', model_id: 'gpt-5.4-mini' })`);
  }
}

/** What an agent supplies to resolve its model config (the rest comes from env + gateway). */
export interface ModelSelection {
  provider: LLMProvider;
  model_id: string;
  custom_slug?: string;
  /** AI Gateway base URL (from global config); empty = direct provider. */
  ai_gateway_base_url: string;
  /** BYOK: provider key is stored in the gateway; the worker sends the gateway auth token instead. */
  byok?: boolean;
  /** Non-default BYOK key alias (sent as `cf-aig-byok-alias`). */
  byok_alias?: string;
  /** OpenAI HTTP API: 'responses' (default) or 'chat'. Only affects provider === 'openai'. */
  openai_api?: 'chat' | 'responses';
  /** Sarvam API version: 'v1' (default) or 'v2' (beta). Only affects provider === 'sarvam'. */
  sarvam_api?: 'v1' | 'v2';
}

/**
 * Layer a per-role override onto a base selection. Only the fields the role sets override the
 * base; the gateway URL always comes from the base (one gateway per environment). This is the
 * single place per-role model resolution happens, so every agent picks roles the same way.
 *
 * NOTE: changing provider for a role without setting model_id is almost always a mistake (model
 * ids aren't portable across providers), so an override that sets `provider` SHOULD also set
 * `model_id` — but we don't enforce it here; the resolved call will simply fail loudly upstream.
 */
export function mergeModelSelection(
  base: ModelSelection,
  override?: ModelRoleConfig,
): ModelSelection {
  if (!override) return base;
  return {
    provider: override.provider ?? base.provider,
    model_id: override.model_id ?? base.model_id,
    custom_slug: override.custom_slug ?? base.custom_slug,
    ai_gateway_base_url: base.ai_gateway_base_url,
    // BYOK + gateway auth + the OpenAI/Sarvam API choices are provider/gateway-wide, not per-role.
    // (byok is inherited but ignored by providers that don't support it — see resolveModelConfig.)
    byok: base.byok,
    byok_alias: base.byok_alias,
    openai_api: base.openai_api,
    sarvam_api: base.sarvam_api,
  };
}

/** Resolve provider secrets + endpoints into a ResolvedModelConfig ready for buildModel(). */
export async function resolveModelConfig(
  env: ModelPortEnv,
  sel: ModelSelection,
): Promise<ResolvedModelConfig> {
  // BYOK only applies to providers whose keys the gateway can hold; sarvam always uses its own
  // pass-through key, so an inherited agent-wide byok=true is ignored for it (a role override of
  // just `{ provider: 'sarvam', model_id }` works on a BYOK agent).
  const byok = (sel.byok ?? false) && sel.provider !== 'sarvam';
  // BYOK: the provider key lives in the gateway, so we skip reading it. Otherwise resolve the
  // provider's own key from secrets. The gateway auth token is read whenever present — an
  // authenticated gateway needs it on every request, BYOK or not.
  let api_key = '';
  if (!byok) {
    if (sel.provider === 'anthropic')  api_key = await readSecret(env.ANTHROPIC_API_KEY);
    if (sel.provider === 'openai')     api_key = await readSecret(env.OPENAI_API_KEY);
    if (sel.provider === 'workers-ai') api_key = await readSecret(env.CF_AI_TOKEN);
    if (sel.provider === 'custom')     api_key = await readSecret(env.CF_AI_TOKEN);
    if (sel.provider === 'sarvam')     api_key = await readSecret(env.SARVAM_API_KEY);
  }
  const aig_authorization = await readSecret(env.CLOUDFLARE_AI_GATEWAY_TOKEN);

  return {
    provider: sel.provider,
    model_id: sel.model_id,
    ai_gateway_base_url: sel.ai_gateway_base_url,
    custom_slug: sel.custom_slug ?? '',
    local_llm_url: env.LOCAL_LLM_URL ?? '',
    api_key,
    byok,
    aig_authorization,
    byok_alias: sel.byok_alias ?? '',
    openai_api: sel.openai_api ?? 'responses',
    sarvam_api: sel.sarvam_api ?? 'v1',
  };
}
