/**
 * Thin text-fallback tool-call parser (AGENT-KERNEL runtime).
 *
 * Cloud providers and properly-configured llama.cpp return structured `tool_calls`. Some local
 * OpenAI-compatible servers instead emit the call as text (```json / ```xml fences,
 * <tool_call>/<functionCall> tags, or a bare JSON object). When a turn yields no structured
 * call, we parse one tool call from the text so the orchestrator keeps working with ANY
 * provider. This is intentionally small — it extracts ONE { name, arguments } call, nothing more.
 */

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s.trim()); } catch { return null; }
}

/** Pull `{ name, arguments }` out of a parsed object (handles a few common shapes). */
function asCall(o: unknown): ParsedToolCall | null {
  if (!o || typeof o !== 'object') return null;
  const obj = o as Record<string, unknown>;
  const name = (obj.name ?? obj.tool ?? obj.function) as unknown;
  const args = (obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? {}) as unknown;
  if (typeof name !== 'string') return null;
  return { name, args: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> };
}

/**
 * Extract a single tool call from model text. `validNames` (if given) filters to known tools so
 * we don't act on a hallucinated name. Returns null if no plausible call is found.
 */
export function parseToolCallFromText(text: string, validNames?: string[]): ParsedToolCall | null {
  if (!text) return null;
  const candidates: string[] = [];
  // Tagged: <tool_call>{…}</tool_call>, <functionCall>{…}</functionCall>, <function_call>…
  for (const m of text.matchAll(/<(?:tool_call|functionCall|function_call|tool▁call)>\s*([\s\S]*?)\s*<\/(?:tool_call|functionCall|function_call|tool▁call)>/g)) candidates.push(m[1]);
  // Fenced: ```json / ```xml / ``` … ```
  for (const m of text.matchAll(/```(?:json|xml|tool_call)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  // Whole text (some servers return a bare JSON object).
  candidates.push(text);

  for (const cand of candidates) {
    // Some models double-brace: {{ "name": … }} — relax to single braces before parsing.
    const cleaned = cand.trim().replace(/^\{\{/, '{').replace(/\}\}$/, '}');
    const call = asCall(tryParse(cleaned)) ?? asCall(tryParse(cand));
    if (call && (!validNames || validNames.includes(call.name))) return call;
  }
  return null;
}
