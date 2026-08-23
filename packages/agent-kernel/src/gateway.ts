// AI Gateway request tagging. Attach {agent_id, run_id} so every model call for a run
// rolls up in the gateway's logs/cost views (complements the full step trace in Langfuse).
//
// Pass the result as `headers` when constructing the provider model (createOpenAI/createAnthropic),
// so each request carries it. Gateway accepts up to 5 metadata entries (string/number/boolean).
export function gatewayMetadataHeaders(agentId: string, runId: string): Record<string, string> {
  return {
    'cf-aig-metadata': JSON.stringify({ agent_id: agentId, run_id: runId }),
  };
}
