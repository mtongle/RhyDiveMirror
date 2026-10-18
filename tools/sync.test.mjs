import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('admin client retries status and sync control-plane 503 responses', async () => {
  const source = await readFile(new URL('./sync.mjs', import.meta.url), 'utf8');
  assert.match(source, /getStatus\(\)[\s\S]*?requestWithRetry\(/);
  assert.match(source, /__admin\/sync[\s\S]*?requestWithRetry\(/);
  assert.match(source, /\[429, 502, 503, 504\]/);
  assert.match(source, /attempt >= 8/);
});

test('admin client preserves bounded subrequest stops', async () => {
  const source = await readFile(new URL('./sync.mjs', import.meta.url), 'utf8');
  assert.match(source, /subrequest budget exhausted with no progress; stopping/);
  assert.match(source, /stalled = true/);
});
