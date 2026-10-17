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

const worker = (args.worker ?? process.env.RHYDIVE_MIRROR_WORKER ?? '').replace(/\/+$/, '');
const token = args.token ?? process.env.SYNC_TOKEN ?? '';
const songs = Number(args.songs ?? 3);
const budgetMs = Number(args.budgetMs ?? 60_000);
const maxRounds = Number(args['max-rounds'] ?? 10_000);
const pauseMs = Number(args.pause ?? 1000);
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
let consecutiveIdleRounds = 0;

for (; round < maxRounds; round++) {
  const before = await getStatus();
  if (before.catalog.officialSongs > 0 && before.queue.pending === 0) {
    if (!jsonOutput) console.log('queue empty; nothing to do');
    break;
  }

  // If catalog is already fetched and has pending songs, skip refreshing catalog on every round
  const skipCatalogParam = before.queue.pending > 0 ? '&skipCatalog=true' : '';
  const response = await fetch(`${worker}/__admin/sync?songs=${songs}&budgetMs=${budgetMs}${skipCatalogParam}`, {
    method: 'POST',
    headers,
  }).catch((err) => ({ ok: false, status: 0, statusText: err.message }));

  if (!response.ok) {
    consecutiveIdleRounds++;
    if (!jsonOutput) console.log(`round ${round + 1}: network error (${response.status}), retrying in 3s...`);
    if (consecutiveIdleRounds > 10) {
      fail(`too many consecutive network errors: HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    continue;
  }

  const payload = await response.json().catch(() => null);
  if (!payload?.success) {
    consecutiveIdleRounds++;
    if (!jsonOutput) console.log(`round ${round + 1}: sync call failed (${JSON.stringify(payload)}), retrying in 3s...`);
    if (consecutiveIdleRounds > 10) {
      fail(`too many consecutive sync errors: ${JSON.stringify(payload)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    continue;
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

  if (payload.run.processed === 0 && payload.run.failed === 0) {
    consecutiveIdleRounds++;
    if (consecutiveIdleRounds > 5) {
      if (!jsonOutput) console.log('no progress made after 5 attempts; stopping');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } else {
    consecutiveIdleRounds = 0;
  }

  if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
}

const after = await getStatus();
const summary = {
  rounds: round,
  processed: totalProcessed,
  failed: totalFailed,
  catalog: after.catalog,
  queue: after.queue,
  storageMiB: Math.round((after.storage?.storedBytes ?? 0) / 1024 / 1024),
};
if (jsonOutput) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(
    `done: ${summary.processed} processed, ${summary.failed} failed, ` +
      `${after.queue.pending} still pending, mirrored ${after.catalog.mirroredSongs}/${after.catalog.officialSongs} songs, ` +
      `${summary.storageMiB} MiB in R2`,
  );
}

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
