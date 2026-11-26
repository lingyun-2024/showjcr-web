import assert from 'node:assert/strict';
import test from 'node:test';
import catalog from '../public/catalog.json' with { type: 'json' };
import { matchesSciZone } from '../public/sci.js';

test('embedded 2025 SCI divisions cover candidate journals and exclude conferences', () => {
  const journals = catalog.filter((venue) => venue.kind === 'journal');
  assert.equal(journals.length, 364);
  const counts = Object.fromEntries(['1', '2', '3', '4', 'none'].map((zone) =>
    [zone, journals.filter((venue) => matchesSciZone(zone, venue.sci)).length]));
  assert.deepEqual(counts, { '1': 36, '2': 57, '3': 79, '4': 89, none: 103 });
  assert.equal(journals.filter((venue) => matchesSciZone('top2', venue.sci)).length, 93);
  assert.ok(catalog.filter((venue) => venue.kind === 'conference').every((venue) => venue.sci === undefined));
  assert.equal(matchesSciZone('none', undefined), false);
  assert.equal(matchesSciZone('2', '1'), false);
});
