// Checks that schema.sql can create what the Worker writes to. The live table
// was altered by hand once and this file was not; nothing noticed, because
// nothing rebuilds the database in the normal course of things — until a fresh
// environment does, and then every sign-up fails.
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const schema = readFileSync('schema.sql', 'utf8');
const worker = readFileSync('src/worker.ts', 'utf8');

/** Column names declared for a table in schema.sql. */
function columnsOf(table, text = schema) {
  const m = text.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\);`, 'i'));
  if (!m) return null;
  return m[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .map((line) => line.split(/[\s(,]/)[0])
    .filter((name) => name && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK)$/i.test(name));
}

/** Column names the Worker names in an INSERT for a table. */
function inserted(table) {
  const m = worker.match(new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)`, 'i'));
  return m ? m[1].split(',').map((c) => c.trim()).filter(Boolean) : [];
}

for (const table of ['subscribers', 'hits', 'events']) {
  const declared = columnsOf(table);
  ok(declared !== null, `schema.sql declares ${table}`);
  if (!declared) continue;

  const used = inserted(table);
  ok(used.length > 0, `the worker inserts into ${table} (${used.join(', ')})`);

  const missing = used.filter((c) => !declared.includes(c));
  ok(missing.length === 0,
    `every column written to ${table} exists in schema.sql${missing.length ? ' — missing ' + missing.join(', ') : ''}`);
}

// The check has to be able to fail, so run the same parser over a schema with
// a column taken out and confirm it notices.
const broken = schema.replace('note       TEXT,', '');
const declaredInBroken = columnsOf('subscribers', broken) ?? [];
const wouldCatch = inserted('subscribers').some((c) => !declaredInBroken.includes(c));
ok(wouldCatch, 'a column missing from the schema is detected (the check can fail)');

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
