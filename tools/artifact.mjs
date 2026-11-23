// Prepares the solo-practice playtest for a claude.ai artifact: copies site/ to OUT_DIR and rewrites
// index.html into a page body (the artifact viewer adds the document skeleton). Online tables need the
// Worker, so the playtest is solo practice only.
//   node tools/artifact.mjs OUT_DIR   → prints the list of supporting files to publish beside index.html
import { cpSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: node tools/artifact.mjs OUT_DIR'); process.exit(1); }
rmSync(out, { recursive: true, force: true });
cpSync(new URL('../site', import.meta.url).pathname, out, { recursive: true });
for (const f of ['404.html', 'manifest.webmanifest', 'js/mock.js']) rmSync(join(out, f), { force: true });

let html = readFileSync(join(out, 'index.html'), 'utf8');
const head = html.match(/<head>([\s\S]*)<\/head>/)[1];
const body = html.match(/<body([^>]*)>([\s\S]*)<\/body>/);
const keep = head.split('\n').filter((l) => /<link rel="stylesheet"|<meta name="theme-color"/.test(l));
html = [
  '<title>Okey</title>',
  ...keep,
  '<script>window.OKEY_PLAYTEST = true;</script>',
  // the viewer adds body; carry the body's attributes over from a script
  `<script>document.body.setAttribute('data-felt','green');document.body.setAttribute('data-screen','home');</script>`,
  body[2].trim(),
].join('\n');
writeFileSync(join(out, 'index.html'), html);

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
console.log(JSON.stringify(walk(out).map((f) => relative(out, f)).filter((f) => f !== 'index.html')));
