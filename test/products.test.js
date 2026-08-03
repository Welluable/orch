import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  githubHttpsUrl,
  githubSshUrl,
  parseRemoteUrl,
} from '../lib/products.js';

describe('github remote URL helpers', () => {
  it('githubSshUrl returns git@github.com:owner/slug.git', () => {
    assert.equal(githubSshUrl('Welluable', 'shipyard'), 'git@github.com:Welluable/shipyard.git');
    assert.equal(githubSshUrl('acme', 'my-app'), 'git@github.com:acme/my-app.git');
  });

  it('githubHttpsUrl remains available for non-init callers', () => {
    assert.equal(githubHttpsUrl('acme', 'my-app'), 'https://github.com/acme/my-app.git');
  });

  it('parseRemoteUrl extracts owner/provider from SSH init remotes', () => {
    const parsed = parseRemoteUrl('git@github.com:Welluable/shipyard.git');
    assert.equal(parsed.provider, 'github');
    assert.equal(parsed.owner, 'Welluable');
    assert.equal(parsed.repo, 'shipyard');
    assert.equal(parsed.url, 'git@github.com:Welluable/shipyard.git');
  });

  it('parseRemoteUrl still accepts HTTPS clone remotes', () => {
    const parsed = parseRemoteUrl('https://github.com/org/cloned-app.git');
    assert.equal(parsed.provider, 'github');
    assert.equal(parsed.owner, 'org');
    assert.equal(parsed.repo, 'cloned-app');
  });
});
