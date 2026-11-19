// Browser-local membership for Tau's named sidebar groups.

export type SpaceGroup = { id: string; name: string; directories: string[] };

export const SPACE_GROUPS_KEY = 'tau-space-groups';

/** Parse browser storage, keeping the first owner of each full directory path. */
export function parseSpaceGroups(raw: string | null): SpaceGroup[] {
  if (raw === null) return [];
  let records: unknown;
  try { records = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(records)) return [];
  const groups: SpaceGroup[] = [];
  const owned = new Set<string>();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id || typeof record.name !== 'string' ||
        !record.name.trim() || !Array.isArray(record.directories) || groups.some(group => group.id === record.id)) continue;
    const directories: string[] = [];
    for (const dir of record.directories) {
      if (typeof dir !== 'string' || !dir.startsWith('/') || owned.has(dir)) continue;
      owned.add(dir);
      directories.push(dir);
    }
    if (directories.length) groups.push({ id: record.id, name: record.name.trim(), directories });
  }
  return groups;
}

/** Assign a group and move its directories out of other groups, removing emptied groups. */
export function putSpaceGroup(groups: SpaceGroup[], group: SpaceGroup): SpaceGroup[] {
  const assigned = new Set(group.directories);
  const next = groups.flatMap(item => {
    if (item.id === group.id) return [group];
    const remaining = item.directories.filter(dir => !assigned.has(dir));
    return remaining.length ? [{ ...item, directories: remaining }] : [];
  });
  if (!groups.some(item => item.id === group.id)) next.push(group);
  return next;
}

/** Overlay saved groups on live directory rows without changing directory order or saved membership. */
export function arrangeSpaceGroups<T extends { cwd: string }>(groups: SpaceGroup[], directories: T[]) {
  const bands = groups.map(group => ({ group, directories: [] as T[] }));
  const owners = new Map<string, T[]>();
  for (const band of bands) for (const cwd of band.group.directories) owners.set(cwd, band.directories);
  const ungrouped: T[] = [];
  for (const directory of directories) (owners.get(directory.cwd) ?? ungrouped).push(directory);
  return { bands, ungrouped };
}
