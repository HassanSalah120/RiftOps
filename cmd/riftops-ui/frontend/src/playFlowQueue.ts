export const PRACTICE_TOOL_QUEUE_ID = 3140;

export type QueueDescriptor = {
  id: number;
  category?: string;
};

export type QueueStartMode = 'matchmaking' | 'custom';

/**
 * Custom and Practice Tool lobbies use League's dedicated start-game route.
 * Every other selection, including "Current lobby", starts matchmaking.
 */
export function queueStartMode(queueId: number, queues: QueueDescriptor[]): QueueStartMode {
  if (queueId === PRACTICE_TOOL_QUEUE_ID) return 'custom';
  const queue = queues.find((candidate) => candidate.id === queueId);
  return String(queue?.category || '').trim().toLowerCase() === 'custom' ? 'custom' : 'matchmaking';
}
