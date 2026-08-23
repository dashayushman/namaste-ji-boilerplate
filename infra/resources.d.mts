export interface ResourceSpec { kind: 'D1Database' | 'KVNamespace' | 'R2Bucket' | 'Queue' | 'AiGateway'; id: string; name: string; why: string }
export function resources(name: string, stage: string): ResourceSpec[];
