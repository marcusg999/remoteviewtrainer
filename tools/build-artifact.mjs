/**
 * Turn the Vite build into an Artifact-ready page.
 *
 * The artifact host wraps the file in its own <!doctype>/<head>/<body>, so the
 * page we publish must be body content only, with <title> and <style> at the
 * top. CSS is inlined; the JS bundle ships as a published sibling file.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'fs';
import path from 'path';

const DIST = 'dist';
const OUT = 'artifact';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'assets'), { recursive: true });

const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
const assets = readdirSync(path.join(DIST, 'assets'));
// The entry chunk is named by vite.config's entryFileNames. Picking "the
// first .js" silently chose a dynamic-import chunk once code splitting was
// introduced, and published it as the page's entry point.
const jsName = 'app.js';
if (!assets.includes(jsName)) {
  throw new Error(`expected entry chunk ${jsName} in dist/assets, found: ${assets.join(', ')}`);
}
const cssName = assets.find((f) => f.endsWith('.css'));

const css = readFileSync(path.join(DIST, 'assets', cssName), 'utf8');
// Every chunk ships, not just the entry: dynamic imports resolve at runtime
// against sibling files and a missing one fails silently in the viewer.
const jsFiles = assets.filter((f) => f.endsWith('.js'));
for (const f of jsFiles) copyFileSync(path.join(DIST, 'assets', f), path.join(OUT, 'assets', f));

// body inner content from the built page
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/gi, '')
  .trim();

// The artifact host supplies its own <head>, so anything in the source page's
// head is dropped. The font links have to be carried into the page content or
// the published build silently falls back to system faces and loses the whole
// typographic treatment. Google Fonts is on the artifact CSP allowlist.
const fontLinks = (html.match(/<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>/g) || []).join('\n');
if (!fontLinks) console.warn('WARNING: no Google Fonts links found to carry over');

const page = `<title>Ganzfeld</title>
${fontLinks}
<style>
/* The host skeleton pads :root for safe areas and sets a body font; this is a
   full-bleed canvas game, so it takes the whole viewport back. */
:root { padding: 0 !important; color-scheme: dark; }
html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: #07060d; }
${css}
</style>
${body}
<script type="module" src="assets/${jsName}"></script>
`;

writeFileSync(path.join(OUT, 'index.html'), page);
console.log(`artifact/index.html  ${(page.length / 1024).toFixed(1)} KB`);
for (const f of jsFiles) {
  console.log(`artifact/assets/${f}  ${(readFileSync(path.join(OUT, 'assets', f)).length / 1024).toFixed(1)} KB`);
}
