/**
 * usabl doctor reports the git version and says plainly when it is older than the oldest version
 * usabl needs. usabl runs `git rev-parse --end-of-options`, which git learned in 2.30, so with an
 * older git the reads of refs fail.
 */
import { describe, expect, it } from 'vitest';
import type { InstallFs } from '../../src/install/index.js';
import type { GhReader } from '../../src/install/branch-rule.js';
import { collectDoctorReport, type DoctorDeps, type SurfaceReport } from '../../src/doctor/index.js';
import { MIN_GIT_VERSION, parseGitVersion, type GitVersionProbe } from '../../src/doctor/git-version.js';

const GH_UNAVAILABLE: GhReader = { getJson: async () => null };

const EMPTY_FS: InstallFs = {
  readFile: async () => null,
  glob: async () => [],
  writeFile: async () => {
    throw new Error('doctor must never write');
  },
};

function deps(probe?: () => Promise<GitVersionProbe>): DoctorDeps {
  return {
    fs: EMPTY_FS,
    readWorkflow: (path) => EMPTY_FS.readFile(path),
    gh: GH_UNAVAILABLE,
    configPath: 'usabl.config.json',
    probePlaywrightChromium: async () => 'wired',
    probeChromiumSandbox: async () => 'available',
    env: {},
    ...(probe === undefined ? {} : { probeGitVersion: probe }),
  };
}

async function gitReport(probe: GitVersionProbe): Promise<SurfaceReport> {
  const found = (await collectDoctorReport(deps(async () => probe))).find((r) => r.id === 'git');
  if (found === undefined) {
    throw new Error('no git report');
  }
  return found;
}

describe('parseGitVersion', () => {
  it('reads the version from the forms git prints', () => {
    expect(parseGitVersion('git version 2.56.0\n')).toEqual({ major: 2, minor: 56, text: '2.56.0' });
    expect(parseGitVersion('git version 2.39.3 (Apple Git-145)\n')).toEqual({ major: 2, minor: 39, text: '2.39.3' });
    expect(parseGitVersion('git version 2.45.1.windows.1\n')).toEqual({ major: 2, minor: 45, text: '2.45.1' });
    expect(parseGitVersion('git version 3.0\n')).toEqual({ major: 3, minor: 0, text: '3.0' });
  });

  it('reads nothing from output it does not recognize', () => {
    expect(parseGitVersion('')).toBeNull();
    expect(parseGitVersion('hub version 2.14.2')).toBeNull();
    expect(parseGitVersion('git version two')).toBeNull();
  });
});

describe('doctor and the git version', () => {
  it('needs git 2.30', () => {
    expect(MIN_GIT_VERSION).toBe('2.30');
  });

  it('reports a git at or past 2.30 as wired and names its version', async () => {
    for (const output of ['git version 2.30.0\n', 'git version 2.56.0\n', 'git version 3.1.0\n']) {
      const git = await gitReport({ kind: 'output', text: output });
      expect(git.state, output).toBe('wired');
      expect(git.label, output).toContain(output.replace('git version ', '').trim());
      expect(git.label, output).toContain('usabl needs 2.30 or later');
    }
  });

  it('reports a git older than 2.30 as drifted, names both versions, and says why and how to fix it', async () => {
    for (const output of ['git version 2.29.2\n', 'git version 1.9.1\n']) {
      const git = await gitReport({ kind: 'output', text: output });
      expect(git.state, output).toBe('drifted');
      const version = output.replace('git version ', '').trim();
      expect(git.label, output).toContain(version);
      expect(git.nextStep, output).toContain(`git ${version} is older than 2.30`);
      expect(git.nextStep, output).toContain('--end-of-options');
      expect(git.nextStep, output).toContain('Install git 2.30 or later');
    }
  });

  it('reports git that is not installed as missing', async () => {
    const git = await gitReport({ kind: 'missing' });
    expect(git.state).toBe('missing');
    expect(git.nextStep).toContain('Install git 2.30 or later');
  });

  it('reports a version it cannot read as unknown, never wired', async () => {
    for (const probe of [{ kind: 'output', text: 'something else' }, { kind: 'failed' }] as const) {
      const git = await gitReport(probe);
      expect(git.state).toBe('unknown');
      expect(git.nextStep).toContain('git --version');
    }
  });

  it('never prints output it does not recognize', async () => {
    const git = await gitReport({ kind: 'output', text: 'git version \u001b[31mred\n' });
    expect(git.state).toBe('unknown');
    expect(git.label + git.nextStep).not.toContain('red');
  });
});
