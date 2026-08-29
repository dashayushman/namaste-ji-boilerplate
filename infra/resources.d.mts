export interface ResourceSpec { kind: 'D1Database' | 'KVNamespace' | 'R2Bucket' | 'Queue' | 'AiGateway'; id: string; name: string; why: string }
export interface ProvisionOpts { r2: boolean; queue: boolean }
export function resources(name: string, stage: string, opts?: Partial<ProvisionOpts>): ResourceSpec[];
export function provisionOpts(env: Record<string, string | undefined>): ProvisionOpts;
