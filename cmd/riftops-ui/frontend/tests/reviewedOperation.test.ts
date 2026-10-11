import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReviewedOperation } from '../src/reviewedOperation.ts';

test('reviewed operation resumes completed/failed operations without submitting again', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const state of ['complete', 'failed', 'cancelled', 'expired']) {
      const requests: string[] = [];
      globalThis.fetch = async (url) => {
        requests.push(String(url));
        return Response.json({ id: 'review', state, total: 1, completed: 1, results: [] });
      };
      assert.equal((await runReviewedOperation('review', 'CONFIRM')).state, state);
      assert.deepEqual(requests, ['/api/operations/status?id=review']);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('preview submits once and observes completion', async () => {
  const originalFetch = globalThis.fetch;
  let posts = 0;
  let reads = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      if (options?.method === 'POST') { posts++; return Response.json({ id: 'review', state: 'running' }); }
      return Response.json({ id: 'review', state: reads++ ? 'complete' : 'preview', total: 1, completed: 1, results: [] });
    };
    assert.equal((await runReviewedOperation('review', 'CONFIRM')).state, 'complete');
    assert.equal(posts, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('an ongoing operation times out honestly without another execution', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.notEqual(options?.method, 'POST');
      return Response.json({ id: 'review', state: 'running', total: 1, completed: 0, results: [] });
    };
    await assert.rejects(runReviewedOperation('review', 'CONFIRM', 0), /still running/);
  } finally { globalThis.fetch = originalFetch; }
});
