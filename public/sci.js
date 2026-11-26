const validZones = new Set(['1', '2', '3', '4', 'none']);

export function readSciZones(tsv, catalog) {
  const [heading, ...lines] = tsv.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const headings = heading.split('\t').map((field) => field.trim());
  const kindIndex = headings.indexOf('类型');
  const nameIndex = headings.indexOf('显示名称');
  const zoneIndex = headings.indexOf('SCI大类分区（2025）');
  if ([kindIndex, nameIndex, zoneIndex].includes(-1)) {
    throw new Error('请选择含「SCI大类分区（2025）」的 ShowJCR 逐条复核 TSV 文件。');
  }
  const idsByName = new Map(catalog.filter((venue) => venue.kind === 'journal')
    .map((venue) => [venue.name.normalize('NFC'), venue.id]));
  const zones = new Map();
  for (const line of lines) {
    const cells = line.split('\t');
    if (cells[kindIndex]?.trim() !== '期刊') continue;
    const name = cells[nameIndex]?.trim().normalize('NFC');
    const id = idsByName.get(name);
    if (!id) continue;
    const cell = cells[zoneIndex]?.trim();
    const zone = cell === '无有效SCI分区' ? 'none' : cell;
    if (!validZones.has(zone)) continue;
    if (zones.has(id) && zones.get(id) !== zone) throw new Error('复核表中存在分区不一致的期刊：' + name);
    zones.set(id, zone);
  }
  if (!zones.size) throw new Error('复核表中没有与本站候选目录匹配的期刊分区。');
  return zones;
}

export function savedSciZones(raw) {
  const entries = JSON.parse(raw || '[]');
  if (!Array.isArray(entries)) return new Map();
  return new Map(entries.filter((entry) =>
    Array.isArray(entry) && /^[0-9a-f]{16}$/.test(entry[0]) && validZones.has(entry[1])));
}

export function matchesSciZone(selected, zone) {
  if (!selected) return true;
  if (selected === 'top2') return zone === '1' || zone === '2';
  return zone === selected;
}
