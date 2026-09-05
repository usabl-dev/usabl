/**
 * A guard against the exact gap #104 fell into: a docs check that exists but never runs, whose
 * silence is indistinguishable from it passing. Every `docs:*` npm script must be referenced by
 * a CI workflow, so a doc check cannot be added and left unwired. This is the tool whose product
 * claim is that absent evidence must not read as clean evidence; its own repository must not ship
 * a check whose absence looks like a pass.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';

const packageJsonUrl = new URL('../../package.json', import.meta.url);
const workflowDirUrl = new URL('../../.github/workflows/', import.meta.url);

describe('docs:* scripts are wired into CI', () => {
  it('every docs:* npm script is run by a workflow', async () => {
    const pkg = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as {
      scripts: Record<string, string>;
    };
    const docsScripts = Object.keys(pkg.scripts).filter((name) => name.startsWith('docs:'));
    // The guard only means something if there are docs scripts to guard.
    expect(docsScripts.length).toBeGreaterThan(0);

    const files = (await readdir(workflowDirUrl)).filter(
      (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
    );
    const workflowText = (
      await Promise.all(files.map((name) => readFile(new URL(name, workflowDirUrl), 'utf8')))
    ).join('\n');

    // A script is wired when a workflow runs it, not merely mentions the string. Matching the
    // `npm run <name>` form is how docs:a11y is wired today and keeps a passing comment from
    // counting as coverage.
    const unwired = docsScripts.filter((name) => !workflowText.includes(`npm run ${name}`));
    expect(
      unwired,
      `these docs scripts are defined but no workflow runs them: ${unwired.join(', ')}`,
    ).toEqual([]);
  });
});
