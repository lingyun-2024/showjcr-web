import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSciZone, readSciZones, savedSciZones } from '../public/sci.js';

const catalog = [
  { id: 'aaaaaaaaaaaaaaaa', kind: 'journal', name: 'Journal A' },
  { id: 'bbbbbbbbbbbbbbbb', kind: 'journal', name: 'Journal B' },
  { id: 'cccccccccccccccc', kind: 'journal', name: 'Journal C' },
  { id: 'dddddddddddddddd', kind: 'conference', name: 'Conference D' },
];
const header = '类型\t显示名称\tSCI大类分区（2025）';

test('SCI import uses the 2025 column and only joins matched journals', () => {
  const tsv = '\uFEFF' + [header, '期刊\tJournal A\t1', '期刊\tJournal B\t2',
    '期刊\tJournal C\t无有效SCI分区', '会议\tConference D\t1', '期刊\tOutside\t4'].join('\r\n');
  const zones = readSciZones(tsv, catalog);
  assert.deepEqual([...zones.values()], ['1', '2', 'none']);
  assert.equal(matchesSciZone('top2', zones.get('aaaaaaaaaaaaaaaa')), true);
  assert.equal(matchesSciZone('top2', zones.get('bbbbbbbbbbbbbbbb')), true);
  assert.equal(matchesSciZone('top2', '3'), false);
  assert.equal(matchesSciZone('2', '1'), false);
  assert.equal(matchesSciZone('none', undefined), false);
  assert.equal(matchesSciZone('none', zones.get('cccccccccccccccc')), true);
  assert.deepEqual(savedSciZones(JSON.stringify([...zones])), zones);
});
test('SCI import rejects different version, no matching journals and conflicting duplicates', () => {
  assert.throws(() => readSciZones(header.replace('2025', '2024'), catalog), /2025/);
  assert.throws(() => readSciZones(header + '\n期刊\tOutside\t1', catalog), /匹配/);
  assert.throws(() => readSciZones(header + '\n期刊\tJournal A\t1\n期刊\tJournal A\t2', catalog), /不一致/);
});
