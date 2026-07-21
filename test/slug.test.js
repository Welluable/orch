import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSlug, generateSlug } from '../lib/slug.js';

const SLUG_SHAPE = /^[a-z]+-[a-z]+-[0-9a-f]{4}$/;

describe('formatSlug', () => {
  it('joins adjective, noun, and hex with hyphens', () => {
    assert.equal(formatSlug('calm', 'otter', '7f3a'), 'calm-otter-7f3a');
  });

  it('does not lowercase or otherwise transform its inputs', () => {
    // formatSlug is a pure formatting helper; callers are responsible for
    // passing already-normalized (lowercase) parts.
    assert.equal(formatSlug('bright', 'pine', 'a921'), 'bright-pine-a921');
  });
});

describe('generateSlug', () => {
  it('produces the documented adjective-noun-hex shape by default', () => {
    const slug = generateSlug();
    assert.match(slug, SLUG_SHAPE);
  });

  it('produces the documented shape for many default calls (node:crypto backed)', () => {
    for (let i = 0; i < 25; i += 1) {
      assert.match(generateSlug(), SLUG_SHAPE);
    }
  });

  it('default calls are highly unlikely to collide', () => {
    const slugs = new Set(Array.from({ length: 50 }, () => generateSlug()));
    assert.equal(slugs.size, 50);
  });

  it('accepts an injectable random source and uses it instead of node:crypto', () => {
    let calls = 0;
    const random = () => {
      calls += 1;
      return 0;
    };
    generateSlug({ random });
    assert.ok(calls > 0, 'generateSlug should consult the injected random source');
  });

  it('is deterministic for a fixed injected random source', () => {
    const first = generateSlug({ random: () => 0 });
    const second = generateSlug({ random: () => 0 });
    assert.equal(first, second);
    assert.match(first, SLUG_SHAPE);
  });

  it('produces different slugs for different fixed random sources', () => {
    const low = generateSlug({ random: () => 0 });
    const high = generateSlug({ random: () => 0.999999 });
    assert.notEqual(low, high);
  });
});
