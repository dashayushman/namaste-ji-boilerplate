/**
 * MCP tool connection (the playbook's external-capability port).
 *
 * Connects to a remote MCP server over Streamable HTTP and exposes its tools as AI SDK tools
 * the orchestrator/subagents can call. Each wrapped tool gets an extra `objective` field (the
 * kernel convention — every call states what it's for); the objective is stripped before the
 * MCP `callTool`. Used for Tavily (web research) but works for any MCP server.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tool, jsonSchema, type ToolSet } from 'ai';
import { z } from 'zod';

export interface McpConnection {
  tools: ToolSet;
  toolNames: string[];
  close: () => Promise<void>;
}

/** A no-op connection (when the MCP can't be reached) so callers can degrade gracefully. */
const EMPTY: McpConnection = { tools: {}, toolNames: [], close: async () => {} };

/**
 * Connect to a remote MCP server and return its tools as AI SDK tools (with an injected
 * `objective` field). Best-effort: returns an empty connection on failure so a research run can
 * still proceed (degraded) rather than crash.
 */
export async function connectMcp(url: string, opts: { clientName?: string } = {}): Promise<McpConnection> {
  try {
    const client = new Client({ name: opts.clientName ?? 'karkhana-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const listed = await client.listTools();

    const tools: ToolSet = {};
    for (const t of listed.tools) {
      // Add an `objective` field to the tool's input schema (kernel convention).
      const base = (t.inputSchema ?? { type: 'object', properties: {} }) as {
        type?: string; properties?: Record<string, unknown>; required?: string[];
      };
      const merged = {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'What you are trying to achieve with this call (one sentence).' },
          ...(base.properties ?? {}),
        },
        required: Array.from(new Set(['objective', ...(base.required ?? [])])),
      };
      tools[t.name] = tool({
        description: t.description ?? t.name,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema(merged as any),
        execute: async (args: unknown) => {
          const { objective: _objective, ...rest } = (args ?? {}) as Record<string, unknown>;
          try {
            const res = await client.callTool({ name: t.name, arguments: rest });
            return (res as { content?: unknown }).content ?? res;
          } catch (e) {
            return { error: String(e) };
          }
        },
      });
    }
    return { tools, toolNames: Object.keys(tools), close: () => client.close() };
  } catch (e) {
    console.warn('[agent-kernel] MCP connect failed (degrading):', e);
    return EMPTY;
  }
}

/** Tavily remote MCP URL (Streamable HTTP). Key is passed as a query param per Tavily docs. */
export function tavilyMcpUrl(apiKey: string): string {
  return `https://mcp.tavily.com/mcp/?tavilyApiKey=${encodeURIComponent(apiKey)}`;
}

/**
 * Tavily web research as AI SDK tools, via its REST API.
 *
 * The MCP *protocol* clients (`@modelcontextprotocol/sdk`) use `eval`/`new Function`, which the
 * Workers runtime forbids ("Code generation from strings disallowed"), so we call Tavily's REST
 * API directly — same capability, and we control the schema so every call carries an `objective`
 * (the kernel convention). All web research for an agent should go through these.
 */
export function tavilyRestTools(apiKey: string, opts: { timeoutMs?: number } = {}): ToolSet {
  // A web call MUST be bounded — without a timeout a stalled connection (VPN half-state, a slow
  // /extract, a network blip) hangs the fetch forever, the tool never returns, and the whole
  // agent loop blocks indefinitely waiting on the tool result. Always cap it and surface a
  // recoverable error so the model can retry or move on.
  const timeoutMs = opts.timeoutMs ?? 30000;
  const call = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    try {
      const res = await fetch(`https://api.tavily.com${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { error: `Tavily ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
      return await res.json();
    } catch (e) {
      const msg = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError'
        ? `Tavily request timed out after ${timeoutMs}ms — try a narrower query or a different source.`
        : String(e);
      return { error: msg };
    }
  };
  const OBJ = z.string().describe('What you are trying to achieve with this call (one sentence).');
  // Bound how much a single web call injects into the model context. Raw Tavily payloads (full
  // page text, many results) can be thousands of tokens each; a few of them overflow the context
  // window. We keep the high-signal fields and truncate long text, so context stays predictable
  // regardless of how big the source pages are.
  const SNIPPET = 600; // chars of per-result/page content kept for the model
  const clipStr = (s: unknown, n: number): unknown => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);
  const shapeSearch = (r: unknown): unknown => {
    const o = r as { answer?: unknown; results?: { title?: unknown; url?: unknown; content?: unknown }[]; error?: unknown };
    if (o?.error) return o;
    return {
      answer: clipStr(o.answer, 1200),
      results: (o.results ?? []).map((x) => ({ title: x.title, url: x.url, content: clipStr(x.content, SNIPPET) })),
    };
  };
  const shapeExtract = (r: unknown): unknown => {
    const o = r as { results?: { url?: unknown; raw_content?: unknown; content?: unknown }[]; error?: unknown };
    if (o?.error) return o;
    return { results: (o.results ?? []).map((x) => ({ url: x.url, content: clipStr(x.raw_content ?? x.content, SNIPPET * 3) })) };
  };
  return {
    tavily_search: tool({
      description: 'Search the web for current, authoritative information (e.g. festival dates, panchang). Returns ranked results (title, url, content) and a synthesized answer.',
      inputSchema: z.object({
        objective: OBJ,
        query: z.string(),
        max_results: z.number().optional(),
        search_depth: z.enum(['basic', 'advanced']).optional(),
      }),
      execute: async ({ query, max_results, search_depth }) =>
        shapeSearch(await call('/search', { query, max_results: Math.min(max_results ?? 5, 6), search_depth: search_depth ?? 'advanced', include_answer: true })),
    }),
    tavily_extract: tool({
      description: 'Extract the full text content of specific web pages by URL (use after search to read a source).',
      inputSchema: z.object({ objective: OBJ, urls: z.array(z.string()) }),
      execute: async ({ urls }) => shapeExtract(await call('/extract', { urls: urls.slice(0, 5) })),
    }),
    tavily_crawl: tool({
      description: 'Crawl a site starting from a URL to gather pages relevant to an instruction (heavier — use sparingly).',
      inputSchema: z.object({ objective: OBJ, url: z.string(), instructions: z.string().optional() }),
      execute: async ({ url, instructions }) => call('/crawl', { url, instructions }),
    }),
    tavily_map: tool({
      description: 'Map a site\'s structure from a URL (list of pages) to discover where calendar/panchang data lives.',
      inputSchema: z.object({ objective: OBJ, url: z.string() }),
      execute: async ({ url }) => call('/map', { url }),
    }),
  };
}
