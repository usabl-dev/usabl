import { describe, expect, it } from 'vitest';
import { parseBundle } from '../../src/intake/schema.js';
import { findDuplicateRequirementId } from '../../src/intake/requirement-ids.js';

function bundleWithId(id: string): unknown {
  return {
    version: 1,
    requirements: [
      {
        id,
        kind: 'content',
        surface: 'home',
        description: 'Primary heading should be present',
        assertion: { type: 'content', selector: 'h1', expectedText: 'Welcome' },
        approved: true,
      },
    ],
  };
}

function reasonFor(id: string): string {
  const result = parseBundle(bundleWithId(id));
  expect(result).toMatchObject({ ok: false, verdict: 'approval_required' });
  if (result.ok) {
    throw new Error('expected the bundle to be refused');
  }
  return result.reason;
}

// Every entry is a character that leaves two different ids looking like one on screen.
// Escape sequences rather than literals, so each case stays readable.
const rejected: Array<[string, string, string]> = [
  ['a leading space', ' account-name', 'U+0020'],
  ['a trailing space', 'account-name ', 'U+0020'],
  ['an inner space', 'account name', 'U+0020'],
  ['a tab', 'account\tname', 'U+0009'],
  ['a newline', 'account\nname', 'U+000A'],
  ['a non-breaking space', 'account\u00a0name', 'U+00A0'],
  ['a null byte', 'account\u0000name', 'U+0000'],
  ['an escape byte', 'account\u001b[2Jname', 'U+001B'],
  ['a soft hyphen', 'account\u00adname', 'U+00AD'],
  ['a zero-width space', 'account\u200bname', 'U+200B'],
  ['a zero-width joiner', 'account\u200dname', 'U+200D'],
  ['a right-to-left override', 'account\u202ename', 'U+202E'],
  ['a line separator', 'account\u2028name', 'U+2028'],
  ['a word joiner', 'account\u2060name', 'U+2060'],
  ['a byte order mark', 'account\ufeffname', 'U+FEFF'],
  ['an ideographic space', 'account\u3000name', 'U+3000'],
  ['a variation selector', 'account\ufe0fname', 'U+FE0F'],
  ['a Hangul filler', 'account\u3164name', 'U+3164'],
  ['a blank braille cell', 'account\u2800name', 'U+2800'],
  ['a private-use code point', 'account\ue000name', 'U+E000'],
  ['a lone surrogate', 'account\ud800name', 'U+D800'],
];

describe('requirement id grammar', () => {
  for (const [label, id, point] of rejected) {
    it(`rejects a requirement id containing ${label} and names the code point`, () => {
      const reason = reasonFor(id);
      expect(reason).toContain('requirements[0].id');
      expect(reason).toContain(point);
    });
  }

  it('names the position of the offending character, counting from one', () => {
    expect(reasonFor('account\u200bname')).toContain('at position 8');
  });

  it('accepts an unassigned code point, because what is unassigned depends on the Node build', () => {
    // U+0378 is reserved and not default-ignorable. Refusing it would make the same requirement
    // file valid under one Unicode version and refused under another.
    expect(/\p{Cn}/u.test('\u0378')).toBe(true);
    expect(parseBundle(bundleWithId('account\u0378name')).ok).toBe(true);
  });

  it('rejects a requirement id that is not in Unicode NFC form', () => {
    // "e" followed by a combining acute prints the same as the single character e-acute.
    // The engine would tell the two ids apart. The person approving a waiver would not.
    expect(reasonFor('cafe\u0301-heading')).toContain('NFC');
  });

  it('accepts the same id written in NFC form', () => {
    expect(parseBundle(bundleWithId('caf\u00e9-heading')).ok).toBe(true);
  });

  it('accepts ordinary ids, including non-Latin ones', () => {
    for (const id of [
      'account-name',
      'account.name',
      'account_name:v2',
      'Konto-Name',
      'アカウント-1',
    ]) {
      expect(parseBundle(bundleWithId(id)).ok).toBe(true);
    }
  });

  it('reports an empty id once, through the field rule', () => {
    const reason = reasonFor('');
    expect(reason).toContain('requirements[0].id: id is required');
    expect(reason.split('requirements[0].id').length - 1).toBe(1);
  });

  it('does not echo a rejected id or a terminal escape sequence it carries', () => {
    const reason = reasonFor('boom\u001b[2Jclear');
    expect(reason).not.toContain('\u001b');
    expect(reason).not.toContain('boom');
    expect(reason).not.toContain('clear');
  });
});

describe('findDuplicateRequirementId', () => {
  it('returns null when every id is distinct', () => {
    expect(
      findDuplicateRequirementId([
        { id: 'a', path: 'requirements/a.yaml' },
        { id: 'b', path: 'requirements/b.yaml' },
      ]),
    ).toBeNull();
  });

  it('names both files when the repeat is in another file', () => {
    const duplicate = findDuplicateRequirementId([
      { id: 'account-name', path: 'requirements/email.yaml' },
      { id: 'account-name', path: 'requirements/name.yaml' },
    ]);
    expect(duplicate).not.toBeNull();
    expect(duplicate?.path).toBe('requirements/name.yaml');
    expect(duplicate?.reason).toContain('account-name');
    expect(duplicate?.reason).toContain('requirements/name.yaml');
    expect(duplicate?.reason).toContain('requirements/email.yaml');
  });

  it('says so when the repeat is in the same file', () => {
    const duplicate = findDuplicateRequirementId([
      { id: 'account-name', path: 'requirements/both.yaml' },
      { id: 'account-name', path: 'requirements/both.yaml' },
    ]);
    expect(duplicate?.reason).toContain('more than once in requirements/both.yaml');
  });

  it('compares exactly and does not fold a cross-script confusable into a repeat', () => {
    expect(
      findDuplicateRequirementId([
        { id: 'varia', path: 'requirements/a.yaml' },
        { id: 'vari\u0430', path: 'requirements/b.yaml' },
      ]),
    ).toBeNull();
  });

  it('scrubs a terminal escape sequence carried by a file path', () => {
    const duplicate = findDuplicateRequirementId([
      { id: 'account-name', path: 'requirements/a.yaml' },
      { id: 'account-name', path: 'requirements/\u001b]0;OWNED\u0007b.yaml' },
    ]);
    expect(duplicate?.reason).not.toContain('\u001b');
    expect(duplicate?.reason).not.toContain('OWNED');
  });
});
