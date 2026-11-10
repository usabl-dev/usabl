import { describe, expect, it } from 'vitest';
import { readFigmaFile } from '../../../src/import/figma/types.js';
import { usersScreen } from './users-screen.fixture.js';

describe('readFigmaFile', () => {
  it('reads the mock file after a JSON round trip, as it arrives from the network', () => {
    const read = readFigmaFile(JSON.parse(JSON.stringify(usersScreen)));
    expect(read?.version).toBe('4242');
    expect(read?.document.children?.[0]?.children?.[0]?.name).toBe('Users');
  });

  it('keeps only the fields usabl reads', () => {
    const read = readFigmaFile(JSON.parse(JSON.stringify(usersScreen)));
    const users = read?.document.children?.[0]?.children?.[0];
    expect(users).not.toHaveProperty('blendMode');
    expect(read).not.toHaveProperty('role');
    expect(read?.components['10:1']).toEqual({ key: 'k-heading-h1', name: 'Level=h1', componentSetId: '10:0' });
  });

  it.each([
    ['an empty object', {}],
    ['a string', 'not a file'],
    ['a node with no id', { ...usersScreen, document: { name: 'Document', type: 'DOCUMENT' } }],
    ['a version that is a number', { ...usersScreen, version: 4242 }],
    ['children that are not a list', { ...usersScreen, document: { ...usersScreen.document, children: 'x' } }],
    ['a box with a value that is not a number', { ...usersScreen, document: { ...usersScreen.document, absoluteBoundingBox: { x: 'a', y: 0, width: 1, height: 1 } } }],
  ])('refuses %s', (_, value) => {
    expect(readFigmaFile(value)).toBeNull();
  });

  it('refuses a file nested too deeply to check, without throwing', () => {
    let node: Record<string, unknown> = { id: 'leaf', name: 'leaf', type: 'FRAME' };
    for (let depth = 0; depth < 20_000; depth += 1) {
      node = { id: `n${depth}`, name: 'n', type: 'FRAME', children: [node] };
    }
    expect(readFigmaFile({ ...usersScreen, document: node })).toBeNull();
  });
});
