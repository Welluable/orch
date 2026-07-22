import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  exitCodeForSignal,
  shutdown,
  trackLiveChild,
  resetShutdownState,
} from '../lib/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(path.join(__dirname, '../lib/agent.js'), 'utf8');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('exitCodeForSignal', () => {
  it('maps SIGINT / SIGTERM / SIGHUP to conventional shell statuses', () => {
    assert.equal(exitCodeForSignal('SIGINT'), 130);
    assert.equal(exitCodeForSignal('SIGTERM'), 143);
    assert.equal(exitCodeForSignal('SIGHUP'), 129);
  });
});

describe('ora discardStdin', () => {
  it('passes discardStdin: false so Ctrl+C delivers a real SIGINT', () => {
    assert.match(agentSrc, /discardStdin:\s*false/);
  });
});

describe('shutdown reaps detached children', () => {
  beforeEach(() => {
    resetShutdownState();
  });

  afterEach(() => {
    resetShutdownState();
  });

  for (const { signal, code } of [
    { signal: 'SIGINT', code: 130 },
    { signal: 'SIGTERM', code: 143 },
    { signal: 'SIGHUP', code: 129 },
  ]) {
    it(`kills a detached stub child and exits ${code} on ${signal}`, async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      assert.ok(child.pid, 'stub child should have a pid');
      assert.equal(pidAlive(child.pid), true);

      let exitedWith;
      const exited = new Promise((resolve) => {
        shutdown(signal, {
          exit: (exitCode) => {
            exitedWith = exitCode;
            resolve();
          },
        });
      });

      await exited;
      assert.equal(exitedWith, code);
      await waitFor(() => !pidAlive(child.pid));
      assert.equal(pidAlive(child.pid), false);
    });
  }
});
