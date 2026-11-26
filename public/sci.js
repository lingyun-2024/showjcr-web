export function matchesSciZone(selected, zone) {
  if (!selected) return true;
  if (selected === 'top2') return zone === '1' || zone === '2';
  return zone === selected;
}
