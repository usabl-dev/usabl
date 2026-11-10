/**
 * `usabl install --ci` fills the engine pin from the build record, so the workflows it writes run
 * with no hand edit. The pin is filled only with a full 40-character commit SHA. Without one the
 * placeholder stays, the report says why and names the line to edit, and the engine checkout of
 * the placeholder fails, so the gate blocks. A pin someone already chose is never moved.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { EnginePin } from '../../src/install/build-info.js';
import {
  ENGINE_REF_PLACEHOLDER,
  USABL_DOCS_GATE_WORKFLOW,
  USABL_DOCS_GATE_WORKFLOW_PATH,
  USABL_GATE_WORKFLOW,
  USABL_GATE_WORKFLOW_PATH,
  classifyDocsGateWorkflow,
  classifyGateWorkflow,
  engineRefLineNumber,
  pinEngineRef,
  planCi,
  planDocsCi,
  writeDocsCi,
} from '../../src/install/ci.js';
import { installCi, USABL_HISTORY_WORKFLOW, USABL_HISTORY_WORKFLOW_PATH } from '../../src/install/history-ci.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const FILLED: EnginePin = { kind: 'filled', sha: SHA, version: '0.3.0' };
const DIRTY: EnginePin = { kind: 'placeholder', reason: 'this usabl was built from a tree with uncommitted changes' };

function memoryFs(files: Record<string, string>): InstallFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    store,
  };
}

function differingLines(a: string, b: string): number[] {
  const left = a.split('\n');
  const right = b.split('\n');
  expect(left.length).toBe(right.length);
  return left.flatMap((line, index) => (line === right[index] ? [] : [index + 1]));
}

describe('pinEngineRef', () => {
  it('changes only the one engine ref line, to the SHA', () => {
    for (const draft of [USABL_GATE_WORKFLOW, USABL_DOCS_GATE_WORKFLOW, USABL_HISTORY_WORKFLOW]) {
      const pinned = pinEngineRef(draft, SHA);
      const line = engineRefLineNumber(draft);
      expect(differingLines(draft, pinned)).toEqual([line]);
      expect(pinned.split('\n')[line - 1]).toBe(`          ref: ${SHA}`);
      expect(pinned).not.toContain(ENGINE_REF_PLACEHOLDER);
    }
  });

  it('reads as wired to doctor once pinned', () => {
    expect(classifyGateWorkflow(pinEngineRef(USABL_GATE_WORKFLOW, SHA))).toBe('wired');
    expect(classifyDocsGateWorkflow(pinEngineRef(USABL_DOCS_GATE_WORKFLOW, SHA))).toBe('wired');
  });

  it('refuses anything but a full lowercase commit SHA, so a branch or tag can never be written', () => {
    for (const ref of ['main', 'v0.3.0', SHA.slice(0, 7), SHA.toUpperCase(), `${SHA}\n`, `${SHA}0`, '', ENGINE_REF_PLACEHOLDER]) {
      expect(() => pinEngineRef(USABL_GATE_WORKFLOW, ref), ref).toThrow(/40-character/);
    }
  });

  it('refuses a draft that does not hold exactly one placeholder ref line', () => {
    expect(() => pinEngineRef(pinEngineRef(USABL_GATE_WORKFLOW, SHA), SHA)).toThrow(/exactly one/);
    expect(() => pinEngineRef(`${USABL_GATE_WORKFLOW}\n          ref: ${ENGINE_REF_PLACEHOLDER}\n`, SHA)).toThrow(/exactly one/);
  });
});

describe('installCi with a build commit', () => {
  it('writes both workflows pinned to the commit, and names it', async () => {
    const fs = memoryFs({});
    const result = await installCi(fs, FILLED);

    expect(result).toMatchObject({ exitCode: 0, action: 'written' });
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_GATE_WORKFLOW, SHA));
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_HISTORY_WORKFLOW, SHA));
    expect(result.message).toContain(SHA);
    expect(result.message).not.toContain(ENGINE_REF_PLACEHOLDER);
  });

  it('is a no-op on a second run', async () => {
    const fs = memoryFs({});
    await installCi(fs, FILLED);
    const before = { ...fs.store };

    expect(await installCi(fs, FILLED)).toMatchObject({ exitCode: 0, action: 'already-wired' });
    expect(fs.store).toEqual(before);
  });

  it('fills the pin in its own unedited placeholder drafts from an earlier run', async () => {
    const fs = memoryFs({
      [USABL_GATE_WORKFLOW_PATH]: USABL_GATE_WORKFLOW,
      [USABL_HISTORY_WORKFLOW_PATH]: USABL_HISTORY_WORKFLOW,
    });

    const result = await installCi(fs, FILLED);

    expect(result).toMatchObject({ exitCode: 0, action: 'written' });
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_GATE_WORKFLOW, SHA));
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_HISTORY_WORKFLOW, SHA));
  });

  it('never moves a pin someone chose, and says how to move it by hand', async () => {
    const gate = pinEngineRef(USABL_GATE_WORKFLOW, OTHER_SHA);
    const history = pinEngineRef(USABL_HISTORY_WORKFLOW, OTHER_SHA);
    const fs = memoryFs({ [USABL_GATE_WORKFLOW_PATH]: gate, [USABL_HISTORY_WORKFLOW_PATH]: history });

    const result = await installCi(fs, FILLED);

    expect(result).toMatchObject({ exitCode: 0, action: 'already-wired' });
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(gate);
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(history);
    expect(result.message).toContain(OTHER_SHA);
    expect(result.message).toContain(SHA);
    expect(result.message).toContain(`line ${engineRefLineNumber(USABL_GATE_WORKFLOW)}`);
  });

  it('reports the full pin when the ref line has no space after the colon', async () => {
    const lineIndex = engineRefLineNumber(USABL_GATE_WORKFLOW) - 1;
    const lines = pinEngineRef(USABL_GATE_WORKFLOW, OTHER_SHA).split('\n');
    lines[lineIndex] = `          ref:${OTHER_SHA}`;
    const gate = lines.join('\n');
    expect(classifyGateWorkflow(gate)).toBe('wired');
    const fs = memoryFs({ [USABL_GATE_WORKFLOW_PATH]: gate });

    const result = await installCi(fs, FILLED);

    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(gate);
    expect(result.message).toContain(`pinned to engine commit ${OTHER_SHA}. No change.`);
  });

  it('reads a pinned workflow as wired when this build has no commit, and leaves it alone', async () => {
    const gate = pinEngineRef(USABL_GATE_WORKFLOW, OTHER_SHA);
    const fs = memoryFs({ [USABL_GATE_WORKFLOW_PATH]: gate });

    const result = await installCi(fs, DIRTY);

    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(gate);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`${USABL_GATE_WORKFLOW_PATH} already matches`);
  });

  it('still refuses a hand-tuned workflow, pin or not', async () => {
    const tuned = pinEngineRef(USABL_GATE_WORKFLOW, SHA).replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    const fs = memoryFs({ [USABL_GATE_WORKFLOW_PATH]: tuned });

    const result = await installCi(fs, FILLED);

    expect(result.exitCode).toBe(2);
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(tuned);
  });
});

describe('installCi without a build commit', () => {
  it('keeps the placeholder, says why, and names the one line to edit in each file', async () => {
    const fs = memoryFs({});
    const result = await installCi(fs, DIRTY);

    expect(result.exitCode).toBe(0);
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(USABL_GATE_WORKFLOW);
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(USABL_HISTORY_WORKFLOW);
    expect(result.message).toContain('uncommitted changes');
    expect(result.message).toContain(ENGINE_REF_PLACEHOLDER);
    expect(result.message).toContain(`line ${engineRefLineNumber(USABL_GATE_WORKFLOW)} of ${USABL_GATE_WORKFLOW_PATH}`);
    expect(result.message).toContain(`line ${engineRefLineNumber(USABL_HISTORY_WORKFLOW)} of ${USABL_HISTORY_WORKFLOW_PATH}`);
    expect(classifyGateWorkflow(fs.store[USABL_GATE_WORKFLOW_PATH] ?? null)).toBe('unpinned');
  });
});

describe('the docs gate with a build commit', () => {
  it('writes the docs gate pinned to the commit', async () => {
    const fs = memoryFs({});
    const result = await writeDocsCi(fs, await planDocsCi(fs, SHA), FILLED);

    expect(result.exitCode).toBe(0);
    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_DOCS_GATE_WORKFLOW, SHA));
    expect(result.message).toContain(SHA);
    expect(result.message).not.toContain(ENGINE_REF_PLACEHOLDER);
  });

  it('plans the app gate pinned the same way', async () => {
    expect(await planCi(memoryFs({}), SHA)).toEqual({
      action: 'write',
      path: USABL_GATE_WORKFLOW_PATH,
      contents: pinEngineRef(USABL_GATE_WORKFLOW, SHA),
    });
  });
});
