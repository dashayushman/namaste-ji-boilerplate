/**
 * Run artifacts (AGENT-KERNEL.md AK-7).
 *
 * Every agent's loop exits with a reviewable deliverable: a Markdown body with a structured
 * (YAML/JSON) frontmatter contract. The frontmatter is the machine-readable production
 * contract; the body is the founder-facing narrative. Stored in the agent's own D1
 * (agent_artifacts) and surfaced on the run in the BO.
 *
 * The kernel owns storage + the contract shape; what the frontmatter MEANS (coverage map,
 * counts, changes-since-last-run) is the agent's domain.
 */
import type { KernelEnv } from './types';

export interface RunArtifact {
  /** Stable id, e.g. `art-<run_id>`. */
  id: string;
  run_id: string;
  agent_id: string;
  /** Artifact type, e.g. 'calendar-report'. */
  kind: string;
  version?: number;
  /** Machine contract — counts, coverage, changes, refs. */
  frontmatter: Record<string, unknown>;
  /** Human-readable Markdown narrative. */
  body: string;
}

/** Persist a run artifact (idempotent on id). Best-effort — never throws into the run. */
export async function writeArtifact(env: Pick<KernelEnv, 'DB'>, a: RunArtifact): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO agent_artifacts (id, run_id, agent_id, kind, version, frontmatter, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    a.id, a.run_id, a.agent_id, a.kind, a.version ?? 1,
    JSON.stringify(a.frontmatter), a.body,
  ).run().catch((e) => console.warn('[agent-kernel] writeArtifact failed (non-fatal):', e));
}

/** Render an artifact as a single Markdown document (YAML frontmatter + body). */
export function artifactToMarkdown(a: RunArtifact): string {
  const fm = Object.entries(a.frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  return `---\n${fm}\n---\n\n${a.body}`;
}
