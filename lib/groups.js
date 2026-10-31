/**
 * Group unresolved failure entries by fingerprint for the panel and inbox.
 *
 * Entries are newest-first from the store, but the grouping works for any order:
 * the latest entry supplies tool/category/severity/report, and first/last times
 * are derived independently.
 */

/**
 * @param {object[]} entries - failure index rows.
 * @returns {object[]} groups sorted by latest failure.
 */
export function groupFailures(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.fingerprint !== 'string' || entry.fingerprint === '') continue;
    const time = typeof entry.time === 'string' ? entry.time : null;
    let group = groups.get(entry.fingerprint);
    if (!group) {
      group = {
        fingerprint: entry.fingerprint,
        count: 0,
        entries: [],
        firstSeen: time,
        lastSeen: time,
      };
      groups.set(entry.fingerprint, group);
    }
    group.count += 1;
    group.entries.push(entry);
    if (group.firstSeen == null || (time != null && Date.parse(time) < Date.parse(group.firstSeen))) {
      group.firstSeen = time;
    }
    if (group.lastSeen == null || (time != null && Date.parse(time) >= Date.parse(group.lastSeen))) {
      group.lastSeen = time;
      group.id = entry.id ?? null;
      group.tool = entry.tool ?? 'tool';
      group.category = entry.category ?? 'unknown';
      group.severity = entry.severity ?? 'medium';
      group.code = entry.code ?? null;
      group.session = entry.session ?? null;
      group.report = entry.report ?? null;
    }
  }
  return [...groups.values()].sort((left, right) => {
    const countDelta = (right.count ?? 0) - (left.count ?? 0);
    if (countDelta !== 0) return countDelta;
    const leftTime = Date.parse(left.lastSeen ?? '');
    const rightTime = Date.parse(right.lastSeen ?? '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
    return String(right.lastSeen ?? '').localeCompare(String(left.lastSeen ?? ''));
  });
}
