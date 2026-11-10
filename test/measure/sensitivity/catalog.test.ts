/**
 * The sensitivity catalog itself: ids are unique, every rule an entry expects is one a shipped
 * check reports, every entry names the WCAG criterion it breaks, and the shipped rule lists the
 * catalog reads match the ids the providers write.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  catalogHash,
  EDIT_KINDS,
  NOT_EXERCISED_REASONS,
  SENSITIVITY_CATALOG,
} from '../../../src/measure/sensitivity/catalog.js';
import {
  DOCS_RULES,
  isKnownRulePattern,
  KEYBOARD_WALK_RULES,
  ruleMatches,
  shippedRules,
} from '../../../src/measure/sensitivity/rules.js';

const known = new Set(shippedRules().map((rule) => rule.rule));

async function ruleIdsWritten(path: string): Promise<string[]> {
  const source = await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
  return [...new Set([...source.matchAll(/rule: '([^']+)'/g)].map((match) => match[1] ?? ''))].sort();
}

describe('the sensitivity catalog', () => {
  it('has entries, each with a unique id', () => {
    const ids = SENSITIVITY_CATALOG.map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('expects only rules a shipped check reports, or a requirement family', () => {
    for (const entry of SENSITIVITY_CATALOG) {
      for (const rule of entry.expectedRules) {
        expect(isKnownRulePattern(rule, known), `${entry.id} expects ${rule}`).toBe(true);
      }
    }
  });

  it('says why when an entry expects no shipped rule', () => {
    for (const entry of SENSITIVITY_CATALOG) {
      if (entry.expectedRules.length === 0) {
        expect(entry.noShippedRule?.trim().length ?? 0, entry.id).toBeGreaterThan(0);
      } else {
        expect(entry.noShippedRule, entry.id).toBeUndefined();
      }
    }
  });

  it('names a WCAG 2.2 success criterion for every entry', () => {
    for (const entry of SENSITIVITY_CATALOG) {
      expect(entry.criterion.id, entry.id).toMatch(/^[1-4]\.\d{1,2}\.\d{1,2}$/);
      expect(entry.criterion.name.trim().length, entry.id).toBeGreaterThan(0);
    }
  });

  it('describes each entry in one plain sentence', () => {
    for (const entry of SENSITIVITY_CATALOG) {
      expect(entry.description, entry.id).toMatch(/^[A-Z].*\.$/);
      expect(entry.description, entry.id).not.toMatch(/—|--/);
    }
  });

  it('uses only the fixed edit kinds and a selector for every target', () => {
    for (const entry of SENSITIVITY_CATALOG) {
      expect(EDIT_KINDS, entry.id).toContain(entry.mutation.edit.kind);
      expect(entry.mutation.target.selector.trim().length, entry.id).toBeGreaterThan(0);
    }
  });

  it('gives a reason only for shipped rules no entry expects', () => {
    const expected = SENSITIVITY_CATALOG.flatMap((entry) => entry.expectedRules);
    for (const rule of Object.keys(NOT_EXERCISED_REASONS)) {
      expect(known.has(rule), rule).toBe(true);
      expect(expected.some((pattern) => ruleMatches(pattern, rule)), rule).toBe(false);
    }
  });

  it('exercises every PatternFly rule', () => {
    const expected = SENSITIVITY_CATALOG.flatMap((entry) => entry.expectedRules);
    for (const rule of shippedRules().filter((entry) => entry.layer === 'pf')) {
      expect(expected, rule.rule).toContain(rule.rule);
    }
  });

  it('hashes the same catalog to the same value', () => {
    expect(catalogHash()).toBe(catalogHash());
    expect(catalogHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the shipped rule lists', () => {
  it('keeps the keyboard walk list equal to the ids the walk writes', async () => {
    expect([...KEYBOARD_WALK_RULES].sort()).toEqual(await ruleIdsWritten('src/providers/keyboard-walk/index.ts'));
  });

  it('keeps the docs list equal to the ids the docs rulepack writes', async () => {
    expect([...DOCS_RULES].sort()).toEqual(await ruleIdsWritten('src/providers/docs-rulepack/heading-order.ts'));
  });

  it('lists axe-core rules, sorted, with no id twice', () => {
    const rules = shippedRules();
    const ids = rules.map((rule) => rule.rule);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('button-name');
    expect(ids).toContain('pf-toast-live-region');
    expect(ids).toContain('rhds-tabs-paired');
  });

  it('matches a requirement family by prefix and an exact id only exactly', () => {
    expect(ruleMatches('intake:*', 'intake:save-announces')).toBe(true);
    expect(ruleMatches('intake:*', 'intake:save/missing-announcement')).toBe(true);
    expect(ruleMatches('button-name', 'button-name')).toBe(true);
    expect(ruleMatches('button-name', 'button-name-x')).toBe(false);
    expect(isKnownRulePattern('voicing:*', known)).toBe(false);
  });
});
