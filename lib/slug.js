import crypto from 'node:crypto';

const ADJECTIVES = [
    'calm', 'bright', 'quiet', 'brave', 'swift', 'gentle', 'bold', 'clever',
    'eager', 'fuzzy', 'lively', 'merry', 'noble', 'plucky', 'quirky', 'rapid',
    'sunny', 'tidy', 'vivid', 'wise',
];

const NOUNS = [
    'otter', 'pine', 'falcon', 'meadow', 'harbor', 'ember', 'boulder', 'cedar',
    'delta', 'forest', 'glacier', 'heron', 'island', 'jasper', 'kestrel',
    'lagoon', 'marsh', 'nectar', 'oasis', 'pebble',
];

/** Pure formatter: joins the parts with hyphens, no normalization. */
export function formatSlug(adjective, noun, hex) {
    return `${adjective}-${noun}-${hex}`;
}

/** Default random source: uniform float in [0, 1), backed by node:crypto. */
function defaultRandom() {
    return crypto.randomBytes(4).readUInt32BE(0) / 0x100000000;
}

function pick(list, random) {
    return list[Math.floor(random() * list.length)];
}

function randomHex(random) {
    let hex = '';
    for (let i = 0; i < 4; i += 1) {
        hex += Math.floor(random() * 16).toString(16);
    }
    return hex;
}

/**
 * Generates an `<adjective>-<noun>-<4-lowercase-hex>` slug. `random` follows
 * the `Math.random()`-style `() => number in [0, 1)` contract and defaults to
 * a node:crypto-backed source.
 */
export function generateSlug({ random = defaultRandom } = {}) {
    const adjective = pick(ADJECTIVES, random);
    const noun = pick(NOUNS, random);
    const hex = randomHex(random);
    return formatSlug(adjective, noun, hex);
}
