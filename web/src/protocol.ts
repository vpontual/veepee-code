/**
 * The wire protocol rc.ts already speaks.
 *
 * Written down as types here rather than inferred at the call site, because the
 * server builds these payloads by hand in eight different `broadcast(...)`
 * calls and nothing has ever checked that a client agrees with them. When the
 * server's events become a shared contract, this file is what it replaces.
 */
export type ServerEvent =
  | { type: 'history'; role: 'user' | 'assistant'; content: string }
  | { type: 'user_message'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; success: boolean; output: string }
  | { type: 'done'; evalCount?: number; tokensPerSecond?: number }
  | { type: 'error_event'; error: string }
  | { type: 'permission_request'; callId: string; tool: string; args?: Record<string, unknown> }
  | { type: 'queued'; ahead: number };

/** Every SSE event name the server can send, mapped to its payload shape. */
export const EVENT_NAMES = [
  'history',
  'user_message',
  'text',
  'tool_call',
  'tool_result',
  'done',
  'error_event',
  'permission_request',
  'queued',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** One rendered entry in the transcript. */
export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; result?: { success: boolean; output: string } }
  | { kind: 'error'; text: string };

export type ConnectionState = 'connecting' | 'live' | 'retrying' | 'unauthorized';

/**
 * How many turns are ahead of yours, or null when nothing is queued.
 *
 * There is exactly one generation in flight at a time — a single DGX Spark
 * whose speed comes from speculative decoding that is fastest at batch size 1.
 * So a queue is expected, not an error, and saying where you are in it is the
 * difference between "waiting" and "broken".
 */
export type QueuedAhead = number | null;

export interface PendingPermission {
  callId: string;
  tool: string;
  args?: Record<string, unknown>;
}
