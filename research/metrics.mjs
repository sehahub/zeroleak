// Reads the three tallies out of D1 and prints the funnel.
//   node research/metrics.mjs
import { execSync } from 'node:child_process';

function q(sql) {
  // One command string rather than an argv array, because npx is a .cmd on
  // Windows and has to go through a shell. Every query here is a literal.
  const out = execSync(
    `npx wrangler d1 execute zeroleak --remote --json --command "${sql}"`,
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const m = out.match(/\[[\s\S]*\]/);
  return m ? JSON.parse(m[0])[0].results : [];
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

const hits = q('SELECT day, path, ref, n FROM hits ORDER BY day DESC, n DESC');
const events = q('SELECT day, name, n FROM events ORDER BY day DESC');
const subs = q('SELECT email, created_at, source, note FROM subscribers ORDER BY created_at DESC');

const total = (rows, filter = () => true) =>
  rows.filter(filter).reduce((a, r) => a + r.n, 0);

const views = total(hits);
const scans = total(events, (e) => e.name === 'scan');
const failed = total(events, (e) => e.name === 'scan-failed');
const cleans = total(events, (e) => e.name === 'clean');
const pctOf = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

console.log('\n=== funnel ===');
console.log(`page views            ${num(views, 6)}`);
console.log(`scans finished        ${num(scans, 6)}   ${pctOf(scans, views)} of views`);
console.log(`scans that errored    ${num(failed, 6)}   ${pctOf(failed, scans + failed)} of attempts`);
console.log(`files cleaned         ${num(cleans, 6)}   ${pctOf(cleans, scans)} of scans`);
console.log(`waiting list          ${num(subs.length, 6)}   ${pctOf(subs.length, scans)} of scans`);

console.log('\n=== where views land ===');
const byPath = new Map();
for (const h of hits) byPath.set(h.path, (byPath.get(h.path) ?? 0) + h.n);
for (const [path, n] of [...byPath].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pad(path, 40)} ${num(n, 5)}`);
}

console.log('\n=== where views come from ===');
const byRef = new Map();
for (const h of hits) {
  const k = h.ref || '(direct or unknown)';
  byRef.set(k, (byRef.get(k) ?? 0) + h.n);
}
for (const [ref, n] of [...byRef].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${pad(ref, 40)} ${num(n, 5)}`);
}

console.log('\n=== by day ===');
const days = [...new Set([...hits.map((h) => h.day), ...events.map((e) => e.day)])].sort().reverse();
console.log(`  ${pad('day', 12)} ${num('views', 6)} ${num('scans', 6)} ${num('cleans', 6)}`);
for (const d of days.slice(0, 21)) {
  console.log(`  ${pad(d, 12)} ${num(total(hits, (h) => h.day === d), 6)}` +
    ` ${num(total(events, (e) => e.day === d && e.name === 'scan'), 6)}` +
    ` ${num(total(events, (e) => e.day === d && e.name === 'clean'), 6)}`);
}

console.log('\n=== waiting list ===');
if (!subs.length) console.log('  (nobody yet)');
for (const s of subs) {
  console.log(`  ${s.created_at.slice(0, 10)}  ${pad(s.email, 34)} ${s.source ?? ''}`);
  if (s.note) console.log(`      "${s.note.replace(/\s+/g, ' ')}"`);
}

// The decision this is all for. Stated up front so it cannot be rationalised
// after the fact.
console.log('\n=== read against the thresholds ===');
const qualified = scans;
if (qualified < 300) {
  console.log(`  ${qualified} scans so far. Too early to decide anything; the bar is 300.`);
} else if (subs.length >= 30) {
  console.log(`  ${subs.length} on the waiting list from ${qualified} scans — build the command-line version.`);
} else if (subs.length < 10) {
  console.log(`  Only ${subs.length} sign-ups from ${qualified} scans (<1%). The automation idea is not the business; find another one.`);
} else {
  console.log(`  ${subs.length} sign-ups from ${qualified} scans. Inconclusive — keep gathering, and read the notes above rather than the count.`);
}
