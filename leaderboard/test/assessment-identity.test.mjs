import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { proofRoutes } from '../src/proof.ts';
import { removeAttendeeData } from '../src/attendee-data.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/profile-v9.sample.json', import.meta.url)));
// Execute the production SQL against SQLite; mirror D1's transactional batch semantics.
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of ['schema.sql', 'migrations/002_assessments.sql', 'migrations/003_assessment_visibility.sql']) {
    sqlite.exec(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
  }
  const db = {
    prepare(sql) {
      let args = [];
      const query = method => {
        const statement = sqlite.prepare(sql);
        return /\?\d/.test(sql)
          ? statement[method](Object.fromEntries(args.map((v, i) => [i + 1, v])))
          : statement[method](...args);
      };
      return {
        bind(...values) { args = values; return this; },
        async first() { return query('get') || null; },
        async all() { return { results: query('all') }; },
        async run() { return { meta: { changes: query('run').changes } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  for (const workshop of ['one', 'two']) {
    sqlite.prepare('INSERT INTO workshops(id,code,name,started_at) VALUES(?,?,?,0)').run(workshop, workshop.toUpperCase(), workshop);
    sqlite.prepare('INSERT INTO attendees VALUES(?,?,?,0)').run(workshop, workshop, 'same-handle');
    sqlite.prepare('INSERT INTO stats(token_hash,workshop_id,updated_at) VALUES(?,?,1)').run(workshop, workshop);
  }
  return { sqlite, DB: db };
}
function owner(workshop) { return { token_hash: workshop, workshop_id: workshop, handle: 'same-handle', open: 1 }; }
async function submit(env, workshop, name, visibility = 'public') {
  return proofRoutes(new Request('https://assessment.example/api/assessment?visibility=' + visibility, {
    method: 'POST', body: JSON.stringify({ ...fixture, name }),
  }), env, async () => owner(workshop));
}
async function get(env, path) { return proofRoutes(new Request('https://board.example' + path), env, async () => null); }

test('same handles stay separate in sequences, profiles and public directory', async t => {
  const env = database(t);
  assert.equal((await (await submit(env, 'one', 'First synthetic person')).json()).snapshot_seq, 1);
  assert.equal((await (await submit(env, 'two', 'Second synthetic person')).json()).snapshot_seq, 1);
  const directory = await (await get(env, '/api/talent')).json();
  assert.equal(directory.count, 2);
  assert.deepEqual(directory.profiles.map(p => p.workshop_id).sort(), ['one', 'two']);
  assert.equal((await get(env, '/@same-handle')).status, 409);
  const first = await (await get(env, '/@same-handle?workshop=one')).text();
  assert.match(first, /First synthetic person/); assert.doesNotMatch(first, /Second synthetic person/);
  const second = await (await get(env, '/@same-handle?workshop=two')).text();
  assert.match(second, /Second synthetic person/); assert.doesNotMatch(second, /First synthetic person/);
});

test('private replacement hides payload and assessment badge only for its owner', async t => {
  const env = database(t);
  await submit(env, 'one', 'Public example'); await submit(env, 'two', 'Other example');
  await submit(env, 'one', 'Private example', 'private');
  const directory = await (await get(env, '/api/talent')).json();
  assert.deepEqual(directory.profiles.map(p => p.workshop_id), ['two']);
  const page = await (await get(env, '/@same-handle?workshop=one')).text();
  assert.doesNotMatch(page, /Private example|Public example|ASSESSMENT SHARED/);
});

test('leave removes all owner records and keeps the same handle in another workshop', async t => {
  const env = database(t);
  await submit(env, 'one', 'First'); await submit(env, 'two', 'Second');
  await removeAttendeeData(env.DB, owner('one'));
  for (const table of ['attendees', 'stats', 'assessments']) {
    assert.deepEqual(env.sqlite.prepare(`SELECT workshop_id FROM ${table}`).all().map(r => r.workshop_id), ['two']);
  }
});

test('failed leave rolls back profiles, counts and credential for retry', async t => {
  const env = database(t); await submit(env, 'one', 'Retry example');
  env.sqlite.exec("CREATE TRIGGER fail_leave BEFORE DELETE ON attendees BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END");
  await assert.rejects(removeAttendeeData(env.DB, owner('one')), /synthetic database failure/);
  for (const table of ['attendees', 'stats', 'assessments']) {
    assert.equal(env.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workshop_id='one'`).get().n, 1);
  }
  env.sqlite.exec('DROP TRIGGER fail_leave');
  await removeAttendeeData(env.DB, owner('one'));
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM attendees WHERE workshop_id='one'").get().n, 0);
});
