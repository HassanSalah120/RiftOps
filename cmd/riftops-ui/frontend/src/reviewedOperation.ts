import { executeReviewedOperation, fetchReviewedOperation } from './api.ts';

/** Resume observation of the same operation; never submit a started operation again. */
export async function runReviewedOperation(id: string, confirmation: string, maxWaitMs = 30_000) {
  let status = await fetchReviewedOperation(id);
  if (status.state === 'preview') {
    await executeReviewedOperation(id, confirmation);
    status = await fetchReviewedOperation(id);
  }
  const deadline = Date.now() + maxWaitMs;
  while (['preview', 'running', 'cancelling'].includes(status.state)) {
    if (Date.now() >= deadline) {
      throw new Error('This operation is still running. Check status to continue watching it; it will not be submitted again.');
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
    status = await fetchReviewedOperation(id);
  }
  return status;
}
