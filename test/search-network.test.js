import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../src/search.js';

test('挂起请求获得 15 秒 AbortSignal，最多尝试三次后返回超时错误', async t => {
  let attempts = 0;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 15_000);
    return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
  });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    attempts++; assert.ok(options.signal.aborted); throw options.signal.reason;
  });
  await assert.rejects(fetchWithRetry('https://example.invalid/', {}, 'PMC'), { name: 'TimeoutError' });
  assert.equal(attempts, 3);
});

test('HTTP 400 不重试，临时 503 释放响应后可恢复', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => { attempts++; return new Response('', { status: 400 }); });
  await assert.rejects(fetchWithRetry('https://example.invalid/', {}, 'PubMed'), /HTTP 400/);
  assert.equal(attempts, 1);
  let cancelled = false; attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return attempts === 1 ? { ok: false, status: 503, body: { cancel: async () => { cancelled = true; } } } : new Response('{"ok":true}');
  });
  const response = await fetchWithRetry('https://example.invalid/', {}, 'PubMed');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(attempts, 2); assert.equal(cancelled, true);
});
