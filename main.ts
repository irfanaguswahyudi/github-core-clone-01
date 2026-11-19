// Entry point: wire the forge up to the trial environment and stay alive until
// the environment declares the trial finished.
//
// The environment hands us its origin through MAKEFUN_ENV_URL. The deal is
// simple: start the forge on any free port, tell the environment which port
// that is, then keep asking whether the trial is over. Nothing else here
// belongs to the contest itself — the forge lives in app.ts.

import { createApp } from './app.ts';

// The environment origin, without any trailing slashes so URL building stays clean.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One request is allowed this long before we give up on it and try again.
const REQUEST_TIMEOUT_MS = 30_000;
// Backoff between retries: start here, double each time, never exceed the cap.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait before retry number `n` (0-based): exponential growth, capped.
function backoffFor(n: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(n, 8));
}

// A request that keeps failing is retried forever; `fatal` decides whether a
// particular failure should kill the process instead.
async function keepTrying<T>(label: string, attempt: () => Promise<T | null>, fatal: (err: unknown) => boolean): Promise<T> {
  let failures = 0;
  for (;;) {
    try {
      const result = await attempt();
      if (result !== null) return result;
    } catch (err) {
      if (fatal(err)) throw err;
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

// Tell the environment our port. 200 means accepted; 409 means some entry
// already registered first, which is fine — we just wait like everyone else.
// 400/405 mean the request itself broke the contract, so there is no point
// retrying. Anything else (including the env not being up yet) is retried.
async function announce(port: number): Promise<void> {
  await keepTrying(
    'register',
    async () => {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      return null;
    },
    (err) => err instanceof Error && err.message.startsWith('register answered HTTP '),
  );
}

// Ask the environment whether the trial is over, until it says yes.
async function waitUntilDone(): Promise<void> {
  await keepTrying(
    'done',
    async () => {
      const res = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { done?: unknown };
      return body.done === true ? true : null;
    },
    () => false,
  );
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
