import test from 'node:test';
import assert from 'node:assert/strict';
// The JSON-extraction rule the agent uses on model output (kept trivially small on purpose).
const extract = (text) => { const m = text.match(/\{[\s\S]*\}/); try { return JSON.parse(m?.[0] ?? '{}'); } catch { return {}; } };
test('extracts JSON from a chatty reply', () => { assert.deepEqual(extract('Sure! {"title":"Rise and shine","line":"Good morning."} done'), { title: 'Rise and shine', line: 'Good morning.' }); });
test('tolerates no JSON', () => { assert.deepEqual(extract('no json here'), {}); });
