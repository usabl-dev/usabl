/**
 * The files a run excluded from its check survive the Result document, and a Result written by an
 * engine that never excluded a file still parses, with none.
 */
import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { parseResultDocument } from '../../src/intake/result-document.js';

const EXCLUDED = { ref: 'src/test/setup.ts', reason: 'This file is in a test folder and no screen imports it.' };

function resultWith(extra: Record<string, unknown>): unknown {
  const result: Result = {
    schemaVersion: 'usabl.result.v1', verdict: null, summary: 'nothing to check (no UI-touching files)', screens: [],
    coverage: { changedFiles: ['src/test/setup.ts'], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true },
    findings: [], receipt: null, dirtyGuardedPaths: [], exitCode: 0, accessibilityVerdict: null,
    accessibilityExitCode: 0, paidDownCount: 0, floorHeadroom: [], floorUnconfirmed: [],
  };
  const document = JSON.parse(JSON.stringify(result)) as { coverage: Record<string, unknown> };
  Object.assign(document.coverage, extra);
  return document;
}

describe('excluded files in the Result document', () => {
  it('keeps each excluded file with its ref and reason', () => {
    expect(parseResultDocument(resultWith({ excludedFiles: [EXCLUDED] })).coverage.excludedFiles).toEqual([EXCLUDED]);
  });

  it('reads a coverage with no excludedFiles field, as an older engine wrote it, as none', () => {
    expect(parseResultDocument(resultWith({})).coverage.excludedFiles).toBeUndefined();
  });

  it('refuses an excluded file that is not a ref and a reason', () => {
    expect(() => parseResultDocument(resultWith({ excludedFiles: [{ ref: 'x' }] }))).toThrow(/excludedFiles/);
    expect(() => parseResultDocument(resultWith({ excludedFiles: 'none' }))).toThrow(/excludedFiles/);
  });
});
