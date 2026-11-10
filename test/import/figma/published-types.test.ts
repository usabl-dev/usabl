/**
 * The mock file and the local Figma types checked against Figma's published types, from
 * @figma/rest-api-spec. Most checks here are made by the type checker: a change on either side that
 * breaks one fails `tsc`, before any test runs.
 *
 * - The mock file is a GetFileResponse, so it is a file Figma could send.
 * - Every GetFileResponse is a FigmaFile, so the local types never refuse, by type, a file Figma can
 *   send. The local types are kept: they hold only the fields usabl reads, as readFigmaFile returns
 *   them, so a published type in their place would claim fields the reader drops.
 * - The package holds types only, and nothing in src imports it.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Component, ComponentProperty, GetFileResponse, Rectangle, SubcanvasNode } from '@figma/rest-api-spec';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  FigmaComponentMeta,
  FigmaComponentProperty,
  FigmaFile,
  FigmaNode,
  FigmaRect,
} from '../../../src/import/figma/types.js';
import { readFigmaFile } from '../../../src/import/figma/types.js';
import { usersScreen } from './users-screen.fixture.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe("the mock file and the local types against Figma's published types", () => {
  it('types the mock file as the answer to GET /v1/files/:key', () => {
    expectTypeOf(usersScreen).toEqualTypeOf<GetFileResponse>();
  });

  it('accepts every published file, node, component, property, and box in the local types', () => {
    expectTypeOf<GetFileResponse>().toMatchTypeOf<FigmaFile>();
    expectTypeOf<SubcanvasNode>().toMatchTypeOf<FigmaNode>();
    expectTypeOf<Component>().toMatchTypeOf<FigmaComponentMeta>();
    expectTypeOf<ComponentProperty>().toMatchTypeOf<FigmaComponentProperty>();
    expectTypeOf<Rectangle>().toMatchTypeOf<FigmaRect>();
  });

  it('reads the mock file, as it arrives from the network', () => {
    expect(readFigmaFile(JSON.parse(JSON.stringify(usersScreen)))).not.toBeNull();
  });

  it('imports the published types nowhere in src', async () => {
    const entries = await readdir(join(ROOT, 'src'), { withFileTypes: true, recursive: true });
    const importers: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = join(entry.parentPath, entry.name);
      if ((await readFile(path, 'utf8')).includes('@figma/rest-api-spec')) importers.push(path);
    }
    expect(importers).toEqual([]);
  });
});
