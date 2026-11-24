// Headless Chrome against the dev server, driven over the DevTools protocol so it waits
// for the page to say it's finished (a console line starting "[done]") before the screenshot.
// usage: node tools/shot.mjs <path?query or full URL> <out.png> [timeout-ms]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [path = '/', outFile = 'shot.png', timeoutMs = '120000'] = process.argv.slice(2);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'manger-shot-'));

const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,720', 'about:blank',
], { stdio: 'ignore' });

const cleanup = async () => {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
};

async function pageSocket() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await pageSocket());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
let onDone;
const done = new Promise((r) => (onDone = r));

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    console.log(`[${msg.params.type}] ${text}`);
    if (text.startsWith('[done]')) onDone();
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log('[exception]', d.exception?.description ?? d.text);
    onDone();
  }
});
const send = (method, params = {}) => new Promise((r) => {
  const id = nextId++;
  pending.set(id, r);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: path.startsWith('http') ? path : `https://localhost:5180${path}` });
const timedOut = await Promise.race([done.then(() => false), new Promise((r) => setTimeout(() => r(true), +timeoutMs))]);
if (timedOut) console.log('[shot] timed out waiting for [done]');
await new Promise((r) => setTimeout(r, 300)); // let the last frame present
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'));
console.log('[shot] saved', outFile);
ws.close();
await cleanup();
