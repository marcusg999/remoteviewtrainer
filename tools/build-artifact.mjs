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
const jsName = assets.find((f) => f.endsWith('.js'));
const cssName = assets.find((f) => f.endsWith('.css'));

const css = readFileSync(path.join(DIST, 'assets', cssName), 'utf8');
copyFileSync(path.join(DIST, 'assets', jsName), path.join(OUT, 'assets', jsName));

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
console.log(`artifact/assets/${jsName}  ${(readFileSync(path.join(OUT, 'assets', jsName)).length / 1024).toFixed(1)} KB`);
