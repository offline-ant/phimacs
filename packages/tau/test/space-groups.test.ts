import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangeSpaceGroups, parseSpaceGroups, putSpaceGroup } from '../public/space-groups.js';

test('each full directory path can move to a new group without moving its namesake', () => {
  const initial = [
    { id: 'one', name: 'One', directories: ['/one/project', '/two/project'] },
    { id: 'two', name: 'Two', directories: ['/three/project'] },
  ];
  const moved = putSpaceGroup(initial, { id: 'three', name: 'Three', directories: ['/one/project', '/three/project'] });
  assert.deepEqual(moved, [
    { id: 'one', name: 'One', directories: ['/two/project'] },
    { id: 'three', name: 'Three', directories: ['/one/project', '/three/project'] },
  ]);
  assert.deepEqual(initial[0].directories, ['/one/project', '/two/project'], 'staged edits do not mutate saved groups');
});

test('saved groups survive reload and a directory disappearing from discovery', () => {
  const saved = [{ id: 'env', name: 'Environment', directories: ['/home/pi', '/home/devices'] }];
  const groups = parseSpaceGroups(JSON.stringify(saved));
  const other = { cwd: '/archive/pi' };
  assert.deepEqual(arrangeSpaceGroups(groups, [other]), {
    bands: [{ group: saved[0], directories: [] }], ungrouped: [other],
  });
  const pi = { cwd: '/home/pi' };
  const devices = { cwd: '/home/devices' };
  assert.deepEqual(arrangeSpaceGroups(groups, [other, devices, pi]), {
    bands: [{ group: saved[0], directories: [devices, pi] }], ungrouped: [other],
  });
});

test('storage data cannot make a directory appear twice or interpret a basename as a path', () => {
  assert.deepEqual(parseSpaceGroups(JSON.stringify([
    { id: 'one', name: 'One', directories: ['/a', '/a', 'relative'] },
    { id: 'two', name: 'Two', directories: ['/b', '/a'] },
    { id: 'two', name: 'Duplicate', directories: ['/c'] },
    null,
  ])), [
    { id: 'one', name: 'One', directories: ['/a'] },
    { id: 'two', name: 'Two', directories: ['/b'] },
  ]);
});
