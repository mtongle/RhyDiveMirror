#!/usr/bin/env node
/**
 * Bulk seeding / maintenance driver for a deployed RhyDive mirror.
 *
 * The worker's cron drains the queue a few songs per tick; a fresh deployment
 * with 600+ songs would take days that way. This script just calls the same
 * `/__admin/sync` endpoint in a loop with a much larger budget until the queue
 * is empty (or a stop condition is hit).
 *
 * Usage:
 *   node tools/sync.mjs --worker https://mirror.example.workers.dev --token "$SYNC_TOKEN"
 *   node tools/sync.mjs --worker http://127.0.0.1:8787 --token dev --songs 25 --max-rounds 5
 *   node tools/sync.mjs --worker … --token … --status        # only print state
 *
 * No dependencies: needs Node 18+ for global fetch.
 */

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: node tools/sync.mjs --worker URL --token TOKEN [options]

Repeatedly drains /__admin/sync until the queue is empty.

Options:
  --worker URL       Deployed mirror URL (or RHYDIVE_MIRROR_WORKER)
  --token TOKEN      Admin token (or SYNC_TOKEN)
  --songs N          Songs requested per round (default 25)
  --budgetMs N       Per-round wall-clock budget (default 120000)
  --max-rounds N     Maximum attempts (default 10000)
  --pause MS         Delay between successful rounds (default 0)
  --status           Print status and exit
  --json             JSON output
  --help             Show this help

Exit codes: 0 queue empty, 1 error, 3 queue still incomplete after stop.`);
  process.exit(0);
}

const worker = (args.worker ?? process.env.RHYDIVE_MIRROR_WORKER ?? '').replace(/\/+$/, '');
const token = args.token ?? process.env.SYNC_TOKEN ?? '';
const songs = positiveInt(args.songs, 6, '--songs');
const budgetMs = positiveInt(args.budgetMs, 120_000, '--budgetMs');
const maxRounds = positiveInt(args['max-rounds'], 10_000, '--max-rounds');
const pauseMs = nonNegativeInt(args.pause, 0, '--pause');
const jsonOutput = Boolean(args.json);

if (!worker) fail('missing --worker (or RHYDIVE_MIRROR_WORKER)');
if (!token) fail('missing --token (or SYNC_TOKEN)');

const headers = { authorization: `Bearer ${token}` };

if (args.status) {
  print(await getStatus());
  process.exit(0);
}

let round = 0;
let totalProcessed = 0;
let totalFailed = 0;
let stalled = false;
let exhausted = false;
let busyRetries = 0;
let transientRetries = 0;

for (; round < maxRounds; round++) {
  const before = await getStatus();
  if (before.catalog.officialSongs > 0 && before.queue.pending === 0) {
    if (!jsonOutput) console.log('queue empty; nothing to do');
    break;
  }

  const response = await fetch(`${worker}/__admin/sync?songs=${songs}&budgetMs=${budgetMs}`, {
    method: 'POST',
    headers,
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 409) {
    busyRetries += 1;
    if (busyRetries > 30) fail('sync remained busy for more than 30 attempts');
    const waitMs = Math.max(1_000, payload?.retryAfterMs ?? 5_000);
    if (!jsonOutput) console.log(`round ${round + 1}: another sync is active; retrying in ${waitMs} ms`);
    round -= 1; // A busy lease is not a completed sync round.
    await sleep(waitMs);
    continue;
  }
  busyRetries = 0;
  if (response.status >= 500) {
    transientRetries += 1;
    if (transientRetries > 8) fail(`sync round ${round + 1} failed after repeated HTTP ${response.status}`);
    const waitMs = Math.min(30_000, 1_000 * 2 ** (transientRetries - 1));
    if (!jsonOutput) console.log(`round ${round + 1}: transient HTTP ${response.status}; retrying in ${waitMs} ms`);
    round -= 1;
    await sleep(waitMs);
    continue;
  }
  transientRetries = 0;
  if (!response.ok || !payload?.success) {
    fail(`sync round ${round + 1} failed: HTTP ${response.status} ${JSON.stringify(payload)}`);
  }

  totalProcessed += payload.run.processed;
  totalFailed += payload.run.failed;
  if (!jsonOutput) {
    console.log(
      `round ${round + 1}: +${payload.run.processed} songs, ${payload.run.failed} failed, ` +
        `${payload.pending} pending (catalog ${before.catalog.mirroredSongs}/${before.catalog.officialSongs})`,
    );
    for (const error of payload.run.errors ?? []) console.log(`  ! ${error.id}: ${error.message}`);
  }
  if (payload.run.processed === 0) {
    if (payload.run.errors?.some((error) => /subrequest budget exhausted/i.test(error.message))) {
      if (!jsonOutput) console.log('subrequest budget exhausted with no progress; stopping');
      stalled = true;
      break;
    }
    if (payload.run.failed === 0) {
      if (!jsonOutput) console.log('no progress made this round; stopping');
      stalled = true;
      break;
    }
  }
  if (pauseMs > 0) await sleep(pauseMs);
}

const after = await getStatus();
exhausted = round >= maxRounds && after.queue.pending > 0;
const summary = {
  rounds: round,
  processed: totalProcessed,
  failed: totalFailed,
  catalog: after.catalog,
  queue: after.queue,
  storedMiB: Math.round((after.storage?.storedBytes ?? 0) / 1024 / 1024),
  storedByTier: after.storage?.storedByTier ?? {},
  complete: after.queue.pending === 0,
  stalled,
  exhausted,
};
if (jsonOutput) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(
    `done: ${summary.processed} processed, ${summary.failed} failed, ` +
      `${after.queue.pending} still pending, mirrored ${after.catalog.mirroredSongs}/${after.catalog.officialSongs} songs, ` +
      `${summary.storedMiB} MiB materialised`,
  );
}
if (!summary.complete) process.exitCode = 3;

async function getStatus() {
  const response = await fetch(`${worker}/__admin/status`, { headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    fail(`status failed: HTTP ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function positiveInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} must be a non-negative integer`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`sync.mjs: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}
