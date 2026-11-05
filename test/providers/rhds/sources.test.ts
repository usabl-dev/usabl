import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RHDS_PACKAGE, RHDS_RULES, RHDS_SOURCES, RHDS_TAGS, RHDS_VERSION } from '../../../src/providers/rhds/sources.js';

// The rules may only say what RHDS says, so every quote must appear word for word in the manifest
// of the pinned release, attached to the element the rule names. The manifest wraps its prose
// across lines, so whitespace is collapsed on both sides before the comparison and nothing else.
// The package exports map hides its root files, so the root is found from its main entry.
const packageRoot = dirname(createRequire(import.meta.url).resolve(RHDS_PACKAGE));
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
const projectJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};

interface Described {
  description?: string;
}
interface Declaration extends Described {
  tagName?: string;
  slots?: Described[];
  attributes?: Described[];
}
const manifest = JSON.parse(readFileSync(join(packageRoot, 'custom-elements.json'), 'utf8')) as {
  modules: Array<{ declarations?: Declaration[] }>;
};
const declarations = manifest.modules.flatMap((mod) => mod.declarations ?? []);

function collapse(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ');
}

function documentedText(tag: string): string[] {
  return declarations
    .filter((declaration) => declaration.tagName === tag)
    .flatMap((declaration) => [
      collapse(declaration.description),
      ...(declaration.slots ?? []).map((slot) => collapse(slot.description)),
      ...(declaration.attributes ?? []).map((attribute) => collapse(attribute.description)),
    ]);
}

describe('RHDS rule sources', () => {
  it('pins the same release that is installed, exactly', () => {
    expect(packageJson.version).toBe(RHDS_VERSION);
    expect(projectJson.devDependencies[RHDS_PACKAGE]).toBe(RHDS_VERSION);
  });

  for (const [rule, sources] of Object.entries(RHDS_SOURCES)) {
    for (const source of sources) {
      it(`${rule} quotes ${source.element} word for word`, () => {
        expect(documentedText(source.element).some((text) => text.includes(source.quote))).toBe(true);
      });
    }
  }

  it('lists the seven rules, sorted', () => {
    expect(RHDS_RULES).toEqual([
      'rhds-accordion-header-parent',
      'rhds-button-accessible-label',
      'rhds-cta-link',
      'rhds-dialog-name',
      'rhds-skip-link-target',
      'rhds-switch-label',
      'rhds-tabs-paired',
    ]);
  });

  it('marks the page with every tag the manifest defines, and only those', () => {
    const defined = [...new Set(declarations.flatMap((declaration) => (declaration.tagName ? [declaration.tagName] : [])))].sort();
    expect([...RHDS_TAGS]).toEqual(defined);
    expect(RHDS_TAGS.every((tag) => tag.startsWith('rh-'))).toBe(true);
  });
});
