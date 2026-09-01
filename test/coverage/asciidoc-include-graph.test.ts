import { describe, it, expect } from 'vitest';
import type { FsGlob } from '../../src/contracts/index.js';
import { buildAdocIncludeGraph } from '../../src/coverage/asciidoc-include-graph.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

describe('buildAdocIncludeGraph', () => {
  it('returns only the root when it has no includes', async () => {
    const fs = fsOf({ 'assembly.adoc': '= Title\n\nSome prose with no includes.\n' });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc']);
    expect(graph.unresolved).toEqual([]);
  });

  it('includes the root file itself among the sources', async () => {
    const fs = fsOf({
      'assembly.adoc': 'include::modules/con_overview.adoc[]\n',
      'modules/con_overview.adoc': 'Overview.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toContain('assembly.adoc');
  });

  it('resolves an assembly that includes two modules (all three present)', async () => {
    const fs = fsOf({
      'assembly.adoc': 'include::modules/con_overview.adoc[]\ninclude::modules/proc_install.adoc[leveloffset=+1]\n',
      'modules/con_overview.adoc': 'Overview.\n',
      'modules/proc_install.adoc': 'Install steps.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual([
      'assembly.adoc',
      'modules/con_overview.adoc',
      'modules/proc_install.adoc',
    ]);
    expect(graph.unresolved).toEqual([]);
  });

  it('builds the transitive closure across assembly -> module -> partial', async () => {
    const fs = fsOf({
      'assembly.adoc': 'include::modules/proc_install.adoc[]\n',
      // The partial is resolved relative to the module's own directory (modules/).
      'modules/proc_install.adoc': 'Steps.\ninclude::partials/note.adoc[]\n',
      'modules/partials/note.adoc': 'A shared note.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toContain('assembly.adoc');
    expect(graph.sources).toContain('modules/proc_install.adoc');
    expect(graph.sources).toContain('modules/partials/note.adoc');
    expect(graph.unresolved).toEqual([]);
  });

  it('resolves relative include targets across subdirectories', async () => {
    const fs = fsOf({
      'guides/master.adoc': 'include::../assemblies/asm.adoc[]\n',
      'assemblies/asm.adoc': 'include::../modules/mod.adoc[]\n',
      'modules/mod.adoc': 'Module body.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'guides/master.adoc');
    expect(graph.sources).toEqual([
      'assemblies/asm.adoc',
      'guides/master.adoc',
      'modules/mod.adoc',
    ]);
    expect(graph.unresolved).toEqual([]);
  });

  it('de-duplicates a module reachable through two parents', async () => {
    const fs = fsOf({
      'assembly.adoc': 'include::a.adoc[]\ninclude::sub/b.adoc[]\n',
      'a.adoc': 'include::shared.adoc[]\n',
      'sub/b.adoc': 'include::../shared.adoc[]\n',
      'shared.adoc': 'Shared content.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    const sharedCount = graph.sources.filter((s) => s === 'shared.adoc').length;
    expect(sharedCount).toBe(1);
    expect(graph.sources).toContain('shared.adoc');
    expect(graph.unresolved).toEqual([]);
  });

  it('terminates on a cycle and keeps both files', async () => {
    const fs = fsOf({
      'a.adoc': 'include::b.adoc[]\n',
      'b.adoc': 'include::a.adoc[]\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'a.adoc');
    expect(graph.sources).toEqual(['a.adoc', 'b.adoc']);
    expect(graph.unresolved).toEqual([]);
  });

  it('does not follow an include inside a ---- listing block', async () => {
    const fs = fsOf({
      'assembly.adoc': [
        '= Example',
        '',
        '----',
        'include::should-not-follow.adoc[]',
        '----',
        '',
        'include::real.adoc[]',
        '',
      ].join('\n'),
      'real.adoc': 'Real content.\n',
      'should-not-follow.adoc': 'Code sample, not a transclusion.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc', 'real.adoc']);
    expect(graph.sources).not.toContain('should-not-follow.adoc');
  });

  it('does not follow an include inside a .... literal or ++++ passthrough block', async () => {
    const fs = fsOf({
      'assembly.adoc': [
        '....',
        'include::literal-sample.adoc[]',
        '....',
        '',
        '++++',
        'include::passthrough-sample.adoc[]',
        '++++',
        '',
        'include::real.adoc[]',
        '',
      ].join('\n'),
      'real.adoc': 'Real content.\n',
      'literal-sample.adoc': 'nope',
      'passthrough-sample.adoc': 'nope',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc', 'real.adoc']);
  });

  it('does not follow an include on a // line comment', async () => {
    const fs = fsOf({
      'assembly.adoc': '// include::commented-out.adoc[]\ninclude::real.adoc[]\n',
      'real.adoc': 'Real content.\n',
      'commented-out.adoc': 'nope',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc', 'real.adoc']);
    expect(graph.sources).not.toContain('commented-out.adoc');
  });

  it('does not follow an include inside a //// block comment', async () => {
    const fs = fsOf({
      'assembly.adoc': [
        '////',
        'include::blocked.adoc[]',
        '////',
        'include::real.adoc[]',
        '',
      ].join('\n'),
      'real.adoc': 'Real content.\n',
      'blocked.adoc': 'nope',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc', 'real.adoc']);
  });

  it('resolves an attribute reference in an include path when the attribute is defined', async () => {
    const fs = fsOf({
      'master.adoc': ':modulesdir: modules\n\ninclude::{modulesdir}/con_overview.adoc[]\n',
      'modules/con_overview.adoc': 'Overview.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'master.adoc');
    expect(graph.sources).toEqual(['master.adoc', 'modules/con_overview.adoc']);
    expect(graph.unresolved).toEqual([]);
  });

  it('resolves an attribute defined in a later-read file (fixpoint over traversal)', async () => {
    const fs = fsOf({
      'master.adoc': 'include::setup.adoc[]\ninclude::{modulesdir}/con.adoc[]\n',
      'setup.adoc': ':modulesdir: modules\n',
      'modules/con.adoc': 'Content.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'master.adoc');
    expect(graph.sources).toContain('modules/con.adoc');
    expect(graph.unresolved).toEqual([]);
  });

  it('records an include with an undefined attribute as unresolved', async () => {
    const fs = fsOf({ 'master.adoc': 'include::{undefinedattr}/con.adoc[]\n' });
    const graph = await buildAdocIncludeGraph(fs, 'master.adoc');
    expect(graph.sources).toEqual(['master.adoc']);
    expect(graph.unresolved).toEqual([
      { from: 'master.adoc', target: '{undefinedattr}/con.adoc', reason: expect.stringMatching(/attribute/i) },
    ]);
  });

  it('records a missing include target as unresolved and still returns the rest', async () => {
    const fs = fsOf({
      'assembly.adoc': 'include::modules/present.adoc[]\ninclude::modules/missing.adoc[]\n',
      'modules/present.adoc': 'Present.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc', 'modules/present.adoc']);
    expect(graph.unresolved).toEqual([
      { from: 'assembly.adoc', target: 'modules/missing.adoc', reason: expect.stringMatching(/not found/i) },
    ]);
  });

  it('rejects a path-traversal include and never reads it', async () => {
    const reads: string[] = [];
    const fs: Pick<FsGlob, 'readFile'> = {
      readFile: async (path: string) => {
        reads.push(path);
        if (path === 'assemblies/asm.adoc') {
          return 'include::../../etc/passwd[]\ninclude::../modules/mod.adoc[]\n';
        }
        if (path === 'modules/mod.adoc') {
          return 'Module body.\n';
        }
        return null;
      },
    };
    const graph = await buildAdocIncludeGraph(fs, 'assemblies/asm.adoc');
    expect(graph.sources).toEqual(['assemblies/asm.adoc', 'modules/mod.adoc']);
    expect(graph.unresolved).toEqual([
      { from: 'assemblies/asm.adoc', target: '../../etc/passwd', reason: expect.stringMatching(/escape|traversal|base root/i) },
    ]);
    expect(reads).not.toContain('../../etc/passwd');
    expect(reads.some((r) => r.includes('etc/passwd'))).toBe(false);
  });

  it('rejects an absolute include target', async () => {
    const fs = fsOf({ 'assembly.adoc': 'include::/etc/passwd[]\n' });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc']);
    expect(graph.unresolved).toHaveLength(1);
    expect(graph.unresolved[0]?.target).toBe('/etc/passwd');
  });

  it('over-approximates conditional includes without evaluating ifdef/endif', async () => {
    const fs = fsOf({
      'assembly.adoc': [
        'ifdef::env-github[]',
        'include::modules/github-note.adoc[]',
        'endif::[]',
        'ifndef::backend-pdf[]',
        'include::modules/html-note.adoc[]',
        'endif::[]',
      ].join('\n'),
      'modules/github-note.adoc': 'gh',
      'modules/html-note.adoc': 'html',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toContain('modules/github-note.adoc');
    expect(graph.sources).toContain('modules/html-note.adoc');
    expect(graph.unresolved).toEqual([]);
  });

  it('de-duplicates repeated unresolved records for the same missing target', async () => {
    const fs = fsOf({
      'assembly.adoc': 'include::gone.adoc[]\ninclude::gone.adoc[]\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.unresolved).toEqual([
      { from: 'assembly.adoc', target: 'gone.adoc', reason: expect.stringMatching(/not found/i) },
    ]);
  });

  it('normalizes a redundant ./ segment in the root and resolved paths', async () => {
    const fs = fsOf({
      'assembly.adoc': 'include::./modules/con.adoc[]\n',
      'modules/con.adoc': 'Content.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, './assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc', 'modules/con.adoc']);
  });

  it('honours a sub-directory base root as the containment boundary', async () => {
    const fs = fsOf({
      // ../escape.adoc climbs above the base root (titles/guide) into titles/.
      'titles/guide/master.adoc': 'include::../escape.adoc[]\ninclude::sub/ok.adoc[]\n',
      'titles/guide/sub/ok.adoc': 'ok',
      'titles/escape.adoc': 'should be rejected: outside base root',
    });
    const graph = await buildAdocIncludeGraph(fs, 'titles/guide/master.adoc', 'titles/guide');
    expect(graph.sources).toEqual(['titles/guide/master.adoc', 'titles/guide/sub/ok.adoc']);
    expect(graph.unresolved).toEqual([
      { from: 'titles/guide/master.adoc', target: '../escape.adoc', reason: expect.stringMatching(/base root|escape/i) },
    ]);
  });

  it('keeps a column-0 include after a ---- block whose body contains a longer ----- run', async () => {
    const fs = fsOf({
      'assembly.adoc': [
        '----',
        'Example showing a delimiter of a different length:',
        '-----',
        '----',
        'include::real.adoc[]',
        '',
      ].join('\n'),
      'real.adoc': 'Real content.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc', 'real.adoc']);
    expect(graph.sources).toContain('real.adoc');
  });

  it('does not let a ----- (5) delimiter close a ---- (4) verbatim block', async () => {
    const fs = fsOf({
      'assembly.adoc': [
        '----',
        'include::inside.adoc[]',
        '-----',
        'include::still-inside.adoc[]',
        '----',
        'include::real.adoc[]',
        '',
      ].join('\n'),
      'real.adoc': 'Real content.\n',
      'inside.adoc': 'nope',
      'still-inside.adoc': 'nope',
    });
    const graph = await buildAdocIncludeGraph(fs, 'assembly.adoc');
    expect(graph.sources).toEqual(['assembly.adoc', 'real.adoc']);
    expect(graph.sources).not.toContain('inside.adoc');
    expect(graph.sources).not.toContain('still-inside.adoc');
  });

  it('terminates on a cyclic attribute definition and records the include as unresolved', async () => {
    const fs = fsOf({
      'master.adoc': ':a: {b}\n:b: {a}\n\ninclude::{a}/x.adoc[]\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'master.adoc');
    expect(graph.sources).toEqual(['master.adoc']);
    expect(graph.unresolved).toEqual([
      { from: 'master.adoc', target: '{a}/x.adoc', reason: expect.stringMatching(/attribute/i) },
    ]);
  });

  it('retains an attribute after an unset directive so the include still resolves (over-approximate)', async () => {
    const fs = fsOf({
      'master.adoc': ':moduledir: modules\n:!moduledir:\n\ninclude::{moduledir}/con.adoc[]\n',
      'modules/con.adoc': 'Content.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'master.adoc');
    expect(graph.sources).toContain('modules/con.adoc');
    expect(graph.unresolved).toEqual([]);
  });

  it('resolves a lowercase attribute reference from a mixed-case definition', async () => {
    const fs = fsOf({
      'master.adoc': ':ModulesDir: modules\n\ninclude::{modulesdir}/con.adoc[]\n',
      'modules/con.adoc': 'Content.\n',
    });
    const graph = await buildAdocIncludeGraph(fs, 'master.adoc');
    expect(graph.sources).toEqual(['master.adoc', 'modules/con.adoc']);
    expect(graph.unresolved).toEqual([]);
  });
});
