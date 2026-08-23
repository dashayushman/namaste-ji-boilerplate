/**
 * MemoryPort — the kernel's long-term memory (AGENT-KERNEL.md §3.2, AGENT-PLATFORM.md §3).
 *
 * One store per agent, scoped by `namespace = agent_id + domain`. Three tiers:
 *   - episodic   : one record per run (decision + outcome). Append-only raw grist.
 *   - semantic   : learned facts, versioned / supersedable.
 *   - procedural : distilled lessons the agent applies next time — the actual learning.
 *
 * The cross-run learning loop: recall (read scoped lessons) → act → grade outcome →
 * write-back (episodic) → consolidate (distil graded episodes into procedural/semantic).
 *
 * Recall is hybrid-by-design; this default impl is the **D1 fallback** (keyword + recency +
 * pinned/support ranking) so memory works locally with no Vectorize. An EmbedderPort can be
 * supplied later to add semantic recall via Vectorize (staging/prod) behind the same API.
 */

export type MemoryKind = 'episodic' | 'semantic' | 'procedural';
export type MemoryStatus = 'active' | 'superseded' | 'retracted';

export interface MemoryRecord {
  kind: MemoryKind;
  content: string;
  confidence?: number;
  support_count?: number;
  source_run_id?: string | null;
  /** null = ungraded episode; set once a real signal grades it (the learn-from-verified gate). */
  outcome_grade?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  pinned?: boolean;
}

export interface RecalledMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  support_count: number;
  status: MemoryStatus;
  pinned: number;
  outcome_grade: string | null;
  source_run_id: string | null;
  created_at: string;
  score?: number;
}

export interface RecallOptions {
  kinds?: MemoryKind[];
  k?: number;
  /** Include only lessons (semantic+procedural). Episodic is for recent-context recall. */
  lessonsOnly?: boolean;
}

export interface MemoryPort {
  recall(query: string, opts?: RecallOptions): Promise<RecalledMemory[]>;
  write(rec: MemoryRecord): Promise<string>;
  list(opts?: { kinds?: MemoryKind[]; includeInactive?: boolean; limit?: number }): Promise<RecalledMemory[]>;
  /** Founder curation: pin/unpin, retract, or supersede a lesson. */
  curate(id: string, action: 'pin' | 'unpin' | 'retract' | 'reactivate'): Promise<boolean>;
  /** Graded episodes not yet distilled — input to consolidation. */
  pendingForConsolidation(limit?: number): Promise<RecalledMemory[]>;
  markConsolidated(ids: string[]): Promise<void>;
}

/** Optional text embedder (Vectorize path). Local D1 recall works without it. */
export interface EmbedderPort {
  readonly id: string;
  readonly dim: number;
  embedText(texts: string[]): Promise<number[][]>;
}

const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const tokenize = (q: string) =>
  Array.from(new Set((q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []))).slice(0, 12);

export function createD1MemoryPort(
  db: D1Database,
  namespace: string,
  _embedder?: EmbedderPort,
): MemoryPort {
  const now = () => new Date().toISOString();

  return {
    async recall(query, opts = {}) {
      const kinds = opts.lessonsOnly ? (['semantic', 'procedural'] as MemoryKind[]) : opts.kinds;
      const k = opts.k ?? 6;
      const today = now();
      const where: string[] = ["namespace = ?", "status = 'active'", "(valid_to IS NULL OR valid_to >= ?)"];
      const binds: unknown[] = [namespace, today];
      if (kinds?.length) {
        where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
        binds.push(...kinds);
      }
      const { results } = await db
        .prepare(`SELECT * FROM agent_memory WHERE ${where.join(' AND ')} ORDER BY pinned DESC, support_count DESC, created_at DESC LIMIT 200`)
        .bind(...binds)
        .all<RecalledMemory & { content: string }>();
      const rows = results ?? [];
      // Keyword + recency + pinned/support ranking (the D1 fallback for semantic recall).
      const terms = tokenize(query);
      const nowMs = Date.now();
      const scored = rows.map((r) => {
        const text = (r.content ?? '').toLowerCase();
        const kw = terms.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
        const ageDays = (nowMs - new Date(r.created_at).getTime()) / 86_400_000;
        const recency = Math.max(0, 1 - ageDays / 180);
        const score = kw * 2 + (r.pinned ? 3 : 0) + Math.min(r.support_count, 5) * 0.5 + recency + (r.confidence ?? 0);
        return { ...r, score };
      });
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return scored.slice(0, k);
    },

    async write(rec) {
      const id = uid(rec.kind);
      await db.prepare(
        `INSERT INTO agent_memory
          (id, namespace, kind, content, confidence, support_count, status, pinned,
           source_run_id, outcome_grade, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      ).bind(
        id, namespace, rec.kind, rec.content, rec.confidence ?? 0.5, rec.support_count ?? 1,
        rec.pinned ? 1 : 0, rec.source_run_id ?? null, rec.outcome_grade ?? null,
        rec.valid_from ?? null, rec.valid_to ?? null,
      ).run();
      return id;
    },

    async list(opts = {}) {
      const where: string[] = ['namespace = ?'];
      const binds: unknown[] = [namespace];
      if (!opts.includeInactive) where.push("status = 'active'");
      if (opts.kinds?.length) {
        where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
        binds.push(...opts.kinds);
      }
      const { results } = await db
        .prepare(`SELECT * FROM agent_memory WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC LIMIT ?`)
        .bind(...binds, opts.limit ?? 100)
        .all<RecalledMemory>();
      return results ?? [];
    },

    async curate(id, action) {
      const map: Record<typeof action, string> = {
        pin: "UPDATE agent_memory SET pinned = 1, updated_at = datetime('now') WHERE id = ? AND namespace = ?",
        unpin: "UPDATE agent_memory SET pinned = 0, updated_at = datetime('now') WHERE id = ? AND namespace = ?",
        retract: "UPDATE agent_memory SET status = 'retracted', updated_at = datetime('now') WHERE id = ? AND namespace = ?",
        reactivate: "UPDATE agent_memory SET status = 'active', updated_at = datetime('now') WHERE id = ? AND namespace = ?",
      };
      const res = await db.prepare(map[action]).bind(id, namespace).run();
      return (res.meta?.changes ?? 0) > 0;
    },

    async pendingForConsolidation(limit = 20) {
      const { results } = await db
        .prepare(
          `SELECT * FROM agent_memory
            WHERE namespace = ? AND kind = 'episodic' AND consolidated = 0 AND outcome_grade IS NOT NULL
            ORDER BY created_at ASC LIMIT ?`,
        )
        .bind(namespace, limit)
        .all<RecalledMemory>();
      return results ?? [];
    },

    async markConsolidated(ids) {
      if (!ids.length) return;
      await db
        .prepare(`UPDATE agent_memory SET consolidated = 1, updated_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids)
        .run();
    },
  };
}
