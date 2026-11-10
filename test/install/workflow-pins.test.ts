/**
 * Every workflow usabl writes runs third-party actions only at a full commit SHA, with the version
 * in a trailing comment, because a tag can be moved to other code after review. And no workflow
 * asks for a secret: the engine repository is public, so the only token any job reads is the run's
 * own GITHUB_TOKEN. Both are checked on every generated workflow, with the placeholder pin and with
 * a filled pin, so a new step or a new workflow cannot slip past them.
 */
import { describe, expect, it } from 'vitest';
import { gateWorkflowFor, pinEngineRef, USABL_DOCS_GATE_WORKFLOW, USABL_GATE_WORKFLOW } from '../../src/install/ci.js';
import { historyWorkflow, USABL_HISTORY_WORKFLOW } from '../../src/install/history-ci.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

const DRAFTS: Array<[string, string]> = [
  ['the app gate', USABL_GATE_WORKFLOW],
  ['the docs gate', USABL_DOCS_GATE_WORKFLOW],
  ['the history workflow', USABL_HISTORY_WORKFLOW],
  // Each workflow for a default branch other than main. The branch name is the only value that
  // changes, so these must hold the same pins and the same lack of secrets.
  ['the app gate for trunk', gateWorkflowFor('trunk')],
  ['the history workflow for trunk', historyWorkflow('trunk')],
];
const WORKFLOWS: Array<[string, string]> = DRAFTS.flatMap(([name, draft]): Array<[string, string]> => [
  [`${name} with the placeholder`, draft],
  [`${name} pinned`, pinEngineRef(draft, SHA)],
]);

// Each `uses:` line that is not `owner/repo@<40 hex> # v<version>`. A quoted "uses" or 'uses' key
// is the same key to YAML, so it is always flagged: the generators never write one.
function unpinnedUses(workflow: string): string[] {
  return workflow
    .split('\n')
    .filter((line) => /^\s*(?:-\s+)?(?:uses|"uses"|'uses')\s*:/.test(line))
    .filter((line) => !/^\s*(?:-\s+)?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/.test(line));
}

// A secret read by index, such as secrets['NAME'], which the name sweep below cannot see.
function indexedSecrets(workflow: string): string[] {
  return workflow.match(/secrets\s*\[/g) ?? [];
}

function secretNames(workflow: string): string[] {
  return [...new Set(workflow.match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].sort();
}

describe('every action a generated workflow runs is pinned to a full commit SHA', () => {
  it('flags a tag, a branch, a short SHA, and a pin with no version comment', () => {
    // The check itself must bite, or the sweep below proves nothing.
    expect(
      unpinnedUses(
        [
          '      - uses: actions/checkout@v5',
          '        uses: actions/checkout@main',
          '        uses: actions/checkout@fbc6f39 # v5.1.0',
          '        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
          '        uses: ./local-action',
          '        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
        ].join('\n'),
      ),
    ).toHaveLength(5);
  });

  it('flags a quoted uses key, which YAML reads the same as a bare one', () => {
    expect(
      unpinnedUses(
        [
          '      - "uses": actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
          "        'uses': actions/checkout@v5",
          '        "uses" : actions/checkout@main',
        ].join('\n'),
      ),
    ).toHaveLength(3);
  });

  it.each(WORKFLOWS)('%s', (_name, workflow) => {
    expect(workflow.split('\n').filter((line) => /uses:/.test(line)).length).toBeGreaterThan(0);
    expect(unpinnedUses(workflow)).toEqual([]);
  });
});

describe('no generated workflow needs a secret beyond the run token', () => {
  it('reads every secret name, so a new one cannot hide', () => {
    expect(secretNames('a: ${{ secrets.ENGINE_TOKEN }}\nb: ${{ secrets.GITHUB_TOKEN }}')).toEqual([
      'secrets.ENGINE_TOKEN',
      'secrets.GITHUB_TOKEN',
    ]);
  });

  it('flags a secret read by index, which secretNames cannot name', () => {
    expect(indexedSecrets("a: ${{ secrets['ENGINE_TOKEN'] }}\nb: ${{ secrets [ 'X' ] }}\nc: ${{ secrets.GITHUB_TOKEN }}")).toHaveLength(2);
  });

  it.each(WORKFLOWS)('%s', (_name, workflow) => {
    expect(indexedSecrets(workflow)).toEqual([]);
    for (const name of secretNames(workflow)) {
      expect(name).toBe('secrets.GITHUB_TOKEN');
    }
    // The engine checkout takes no token input of any name.
    expect(workflow).not.toMatch(/^\s*token:/m);
    expect(workflow).not.toMatch(/ENGINE[A-Z_]*TOKEN/);
  });
});
