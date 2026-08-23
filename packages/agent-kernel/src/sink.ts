import type { KernelEnv, RunEvent } from './types';

// Emit a run lifecycle event to the control plane for the central run index.
//
// Transport selection (scalable in cloud, reliable locally):
//   - CONTROL_PLANE binding        → worker-to-worker fetch to console-api. Bypasses Cloudflare
//     Access (ingress-only), so internal events reach the Access-gated console host (staging/prod).
//   - else JOBS queue binding      → enqueue. Ranked BELOW the direct sink on purpose: nothing
//     consumes run-events off the jobs queue today, and a stray JOBS binding used to swallow the
//     content agents' runs silently (2026-08-22). Only meaningful once a consumer exists.
//   - else CONTROL_PLANE_URL set   → POST to the console-api internal ingest (local dev, where
//     cross-worker queues aren't shared and the host isn't behind Access).
//   - else                         → no-op (run still recorded in the agent's own D1).
//
// Best-effort: never throw — observability must not break a run.
export async function emitRunEvent(env: KernelEnv, event: RunEvent): Promise<void> {
  try {
    const headers = {
      'content-type': 'application/json',
      'x-run-event-secret': env.RUN_EVENT_SECRET ?? '',
    };
    const body = JSON.stringify(event);
    // Service binding first: worker-to-worker calls skip the Access edge check on the console host.
    if (env.CONTROL_PLANE) {
      await env.CONTROL_PLANE.fetch('https://control-plane/internal/run-events', { method: 'POST', headers, body });
      return;
    }
    if (env.JOBS) {
      await env.JOBS.send({ kind: 'run-event', event });
      return;
    }
    if (env.CONTROL_PLANE_URL) {
      await fetch(`${env.CONTROL_PLANE_URL}/internal/run-events`, { method: 'POST', headers, body });
    }
  } catch (e) {
    console.warn('[agent-kernel] emitRunEvent failed (non-fatal):', e);
  }
}
