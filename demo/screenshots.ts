/**
 * Captures the README screenshots from the demo graph.
 *
 *   make screenshots
 *
 * Starts `ndoor ui` on the invented Tallgrass Ridge graph (demo/out/graph.lbug),
 * drives a private agent-browser session through each screen, and writes PNGs to
 * docs/screenshots. It reads only the demo graph and never touches your own data
 * or Nextdoor.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH = join(ROOT, 'demo', 'out', 'graph.lbug');
const OUT = join(ROOT, 'docs', 'screenshots');
const SESSION = 'ndoor-demo-shots';

interface Shot {
  file: string;
  /** The hash route to open. */
  hash: string;
  /** Milliseconds to let charts and graphs settle after load. */
  settle?: number;
  /** Extra steps, as agent-browser arguments, run before the capture. */
  steps?: string[][];
}

const SHOTS: Shot[] = [
  { file: 'overview', hash: '#/overview', settle: 3000 },
  { file: 'community-3d', hash: '#/community', settle: 9000 },
  { file: 'explore', hash: '#/explore/Post/post_civic-07', settle: 5000 },
  { file: 'businesses', hash: '#/businesses', settle: 3000 },
  { file: 'business-detail', hash: '#/business/entity_harrow_roofing', settle: 3000 },
];

const browser = (...args: string[]) =>
  execFileSync('agent-browser', ['--session', SESSION, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

/** Start the UI server and resolve with its private link. */
function startUi(): Promise<{ url: string; stop: () => void }> {
  return new Promise((resolveUi, reject) => {
    const child: ChildProcess = spawn('pnpm', ['exec', 'tsx', 'src/index.ts', 'ui', '--db', GRAPH, '--port', '0'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let seen = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colors from the CLI output
      const match = seen.replace(/\u001b\[[0-9;]*m/g, '').match(/ndoor ui at (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
      if (match) resolveUi({ url: match[1], stop: () => child.kill('SIGTERM') });
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`ndoor ui exited early (${code})`)));
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const ui = await startUi();
  try {
    browser('set', 'viewport', '1440', '900', '1.5');
    for (const shot of SHOTS) {
      browser('open', `${ui.url}${shot.hash}`);
      browser('wait', String(shot.settle ?? 2500));
      for (const step of shot.steps ?? []) browser(...step);
      const file = join(OUT, `${shot.file}.png`);
      browser('screenshot', file);
      console.log(`wrote ${file}`);
    }
  } finally {
    browser('close');
    ui.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
