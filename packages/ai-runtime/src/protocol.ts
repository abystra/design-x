import { z } from 'zod';
export const RUNNER_PROTOCOL = 2 as const;
export const CODEX_VERSION = '0.166.0';
const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/);
export const RunnerEventSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL), attemptId: identity, fence: z.number().int().positive(),
  sequence: z.number().int().positive(), type: z.string().max(80), payload: z.record(z.string(), z.unknown()),
}).strict();
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;
export interface RunnerCommand {
  commandId: string; type: 'answer' | 'stop' | 'toolResult';
  requestId?: string | number; answers?: unknown; result?: unknown; success?: boolean;
}
export interface RuntimeSession {
  id: string; projectId: string; attemptId: string; fence: number; deadline: number;
  sandboxId?: string; threadId?: string; cursor?: number; resumeAttempt?: boolean;
}
export interface MaterialMount {
  manifestBytes: Uint8Array; prefix: string; bucket: string; endpoint: string; readBudgetBytes: number;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string | Date; ttlSeconds: number };
}
export interface RunnerTool { name: string; description: string; inputSchema: Record<string, unknown> }

export function parseJournal(raw: string, session: RuntimeSession, cursor: number) {
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('Runner journal batch exceeded limit');
  const parsed = z.object({ events: z.array(RunnerEventSchema).max(128), cursor: z.number().int().nonnegative() }).parse(JSON.parse(raw));
  let expected = cursor + 1;
  for (const event of parsed.events) {
    if (event.attemptId !== session.attemptId || event.fence !== session.fence || event.sequence !== expected++)
      throw new Error('Runner journal identity, fence or cursor mismatch');
  }
  if (parsed.cursor !== expected - 1) throw new Error('Runner journal cursor mismatch');
  return parsed;
}

export function shellQuote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
