/**
 * usabl init prints text that comes from files in the repository: route paths, include targets,
 * file and folder names, and topic names. That text can hold a terminal control sequence. Every
 * such string is printed with each control character labelled by its code point, so nothing raw
 * reaches the terminal and a name with a control sequence never reads as a clean name.
 */
import { describe, expect, it } from 'vitest';
import { formatInitReport, inferInit, writeInitDrafts, type InitFs } from '../../src/init/index.js';
import { inferAsciidocModular } from '../../src/init/docs/asciidoc-modular.js';
import { inferAsciibinder } from '../../src/init/docs/asciibinder.js';
import { formatDocsInitReport, writeDocsInitDraft, type DocsInitFs } from '../../src/init/docs/index.js';
import { matchGlob } from '../../src/primitives/match-glob.js';

function memoryFs(files: Record<string, string>): InitFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    // A memory store has no symbolic links, so every path is its own real path.
    realpath: async (path) => path,
    store,
  };
}

// Any C0 or C1 control character other than the line break that separates printed lines.
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

function expectNoRawControl(text: string): void {
  expect(RAW_CONTROL.test(text)).toBe(false);
}

function noteWith(notes: readonly string[], part: string): string {
  const note = notes.find((line) => line.includes(part));
  expect(note, `no note contains ${part}`).toBeDefined();
  return note ?? '';
}

function appFiles(routes: string): Record<string, string> {
  return {
    'vite.config.ts': `import { defineConfig } from 'vite'\nexport default defineConfig({ server: { port: 5173 } })\n`,
    'src/App.tsx': `import { Route, Routes } from 'react-router-dom'
import { Overview } from './pages/Overview'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Overview />} />
${routes}
    </Routes>
  )
}
`,
    'src/pages/Overview.tsx': 'export function Overview() { return null }\n',
    'src/main.tsx': 'import "./App"\n',
  };
}

describe('usabl init labels control characters in route paths', () => {
  it('labels an OSC title sequence in an unproven route path', async () => {
    const fs = memoryFs(appFiles('      <Route path="//ev\u001b]0;pwn\u0007il" element={<Overview />} />'));
    const draft = await inferInit(fs);
    const result = await writeInitDrafts(fs, draft, { force: false });
    const report = formatInitReport(draft, result);
    expectNoRawControl(report);
    expect(noteWith(draft.notes, 'skipped unproven route path')).toContain('"//ev<U+001B>]0;pwn<U+0007>il"');
  });

  it('labels a color sequence in a route path with @', async () => {
    const fs = memoryFs(appFiles('      <Route path="/a@\u001b[31mb" element={<Overview />} />'));
    const draft = await inferInit(fs);
    const result = await writeInitDrafts(fs, draft, { force: false });
    expectNoRawControl(formatInitReport(draft, result));
    expect(noteWith(draft.notes, 'skipped unproven route path')).toContain('"/a@<U+001B>[31mb"');
  });
});

function docsFs(files: Record<string, string>): DocsInitFs {
  return memoryFs(files);
}

describe('usabl init --docs labels control characters in Pantheon notes', () => {
  const assembly = '[id="assembly_one"]\n= One\n';

  it('labels a missing include target', async () => {
    const fs = docsFs({
      'titles/guide/master.adoc': 'include::assemblies/missing\u001b]0;pwn\u0007.adoc[]\n\ninclude::../../assemblies/one.adoc[]\n',
      'assemblies/one.adoc': assembly,
    });
    const draft = await inferAsciidocModular(fs);
    const result = await writeDocsInitDraft(fs, draft, { force: false });
    expectNoRawControl(formatDocsInitReport(draft, result));
    expect(noteWith(draft.notes, 'points at a missing file')).toBe(
      'Review: include "assemblies/missing<U+001B>]0;pwn<U+0007>.adoc" in titles/guide/master.adoc points at a missing file and was skipped.',
    );
  });

  it('labels an include target that escapes the repo root', async () => {
    const draft = await inferAsciidocModular(
      docsFs({
        'titles/guide/master.adoc': 'include::../../../out\u001b]0;pwn\u0007.adoc[]\n\ninclude::../../assemblies/one.adoc[]\n',
        'assemblies/one.adoc': assembly,
      }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    expect(noteWith(draft.notes, 'escapes the repo root')).toContain('"../../../out<U+001B>]0;pwn<U+0007>.adoc"');
  });

  it('labels a guide folder name in the master path', async () => {
    const draft = await inferAsciidocModular(
      docsFs({
        'titles/gu\u001b]0;pwn\u0007ide/master.adoc': 'include::missing.adoc[]\n\ninclude::../../assemblies/one.adoc[]\n',
        'assemblies/one.adoc': assembly,
      }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    expect(noteWith(draft.notes, 'points at a missing file')).toContain('in titles/gu<U+001B>]0;pwn<U+0007>ide/master.adoc');
  });

  it('labels an assembly file name in the guessed pageId note', async () => {
    const draft = await inferAsciidocModular(
      docsFs({
        'titles/guide/master.adoc': 'include::../../assemblies/o\u001b]0;pwn\u0007ne.adoc[]\n',
        'assemblies/o\u001b]0;pwn\u0007ne.adoc': '= One\n',
      }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    expect(noteWith(draft.notes, 'no anchor found')).toContain('in assemblies/o<U+001B>]0;pwn<U+0007>ne.adoc.');
  });

  it('labels the including file and the target of an unresolved include', async () => {
    const draft = await inferAsciidocModular(
      docsFs({
        'titles/guide/master.adoc': 'include::../../assemblies/o\u001b]0;x\u0007ne.adoc[]\n',
        'assemblies/o\u001b]0;x\u0007ne.adoc': '[id="assembly_one"]\n= One\n\ninclude::../modules/gone\u001b]0;pwn\u0007.adoc[]\n',
      }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    const note = noteWith(draft.notes, 'unresolved include');
    expect(note).toContain('in assemblies/o<U+001B>]0;x<U+0007>ne.adoc:');
    expect(note).toContain('"../modules/gone<U+001B>]0;pwn<U+0007>.adoc"');
  });

  it('labels the assembly file in the refusal for an unusable pageId', async () => {
    let message = '';
    try {
      await inferAsciidocModular(
        docsFs({
          'titles/guide/master.adoc': 'include::../../assemblies/o\u001b]0;pwn\u0007ne.adoc[]\n',
          'assemblies/o\u001b]0;pwn\u0007ne.adoc': '[id="has space"]\n= One\n',
        }),
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('refused to write usabl.docs.json');
    expectNoRawControl(message);
    expect(message).toContain('  assemblies/o<U+001B>]0;pwn<U+0007>ne.adoc: its anchor pageId');
  });
});

describe('usabl init --docs labels control characters in AsciiBinder notes', () => {
  function topicMap(topics: string): string {
    return `---\nName: Guide\nDir: guide\nTopics:\n  - Name: Overview\n    File: overview\n${topics}`;
  }
  const base = { 'guide/overview.adoc': '= Overview\n' };

  it('labels a topic name in the malformed topic note', async () => {
    const draft = await inferAsciibinder(
      docsFs({ ...base, '_topic_maps/_topic_map.yml': topicMap('  - Name: "Bad\\e]0;pwn\\aName"\n') }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    expect(noteWith(draft.notes, 'neither Topics nor File')).toContain('"Bad<U+001B>]0;pwn<U+0007>Name"');
  });

  it('labels a topic file that escapes the repo root', async () => {
    const draft = await inferAsciibinder(
      docsFs({ ...base, '_topic_maps/_topic_map.yml': topicMap('  - Name: Out\n    File: "../../o\\e[31mut"\n') }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    const note = noteWith(draft.notes, 'escapes the repo root');
    expect(note).toContain('topic "../../o<U+001B>[31mut"');
    expect(note).toContain('"../o<U+001B>[31mut.adoc"');
  });

  it('labels a topic source file that does not exist', async () => {
    const draft = await inferAsciibinder(
      docsFs({ ...base, '_topic_maps/_topic_map.yml': topicMap('  - Name: Gone\n    File: "go\\e]0;pwn\\ane"\n') }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    expect(noteWith(draft.notes, 'does not exist')).toContain('guide/go<U+001B>]0;pwn<U+0007>ne.adoc');
  });

  it('labels a topic file and its url in the unsafe url note', async () => {
    const draft = await inferAsciibinder(
      docsFs({
        ...base,
        'guide/a@b\u001b[31m.adoc': '= Unsafe\n',
        '_topic_maps/_topic_map.yml': topicMap('  - Name: Unsafe\n    File: "a@b\\e[31m"\n'),
      }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    const note = noteWith(draft.notes, 'unsafe url');
    expect(note).toContain('topic "a@b<U+001B>[31m"');
    expect(note).toContain('"/guide/a@b<U+001B>[31m.html"');
  });

  it('labels the target of an unresolved include', async () => {
    const draft = await inferAsciibinder(
      docsFs({
        '_topic_maps/_topic_map.yml': topicMap(''),
        'guide/overview.adoc': '= Overview\n\ninclude::gone\u001b]0;pwn\u0007.adoc[]\n',
      }),
    );
    expectNoRawControl(draft.notes.join('\n'));
    expect(noteWith(draft.notes, 'unresolved include')).toContain('"gone<U+001B>]0;pwn<U+0007>.adoc"');
  });

  // The YAML reader quotes the bad line of the file in its error. A raw control character in the
  // topic map would reach the terminal through that quote.
  it('names a topic map that is not valid YAML without quoting its raw text', async () => {
    let message = '';
    try {
      await inferAsciibinder(docsFs({ '_topic_maps/_topic_map.yml': '---\nName: Bad\u001b]0;pwn\u0007Name\n' }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expectNoRawControl(message);
    expect(message).toContain('usabl init --docs could not read _topic_maps/_topic_map.yml: it is not valid YAML');
    expect(message).toContain('at line 2,');
    expect(message).toContain('Nothing was written.');
  });

  it('labels the topic source file in the refusal for an unusable pageId', async () => {
    let message = '';
    try {
      await inferAsciibinder(
        docsFs({
          '_topic_maps/_topic_map.yml': '---\nName: Guide\nTopics:\n  - Name: Odd\n    File: "\\e]\\a"\n',
          '\u001b]\u0007.adoc': '= Odd\n',
        }),
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('refused to write usabl.docs.json');
    expectNoRawControl(message);
    expect(message).toContain('  <U+001B>]<U+0007>.adoc: the pageId slugged from its path');
  });
});
