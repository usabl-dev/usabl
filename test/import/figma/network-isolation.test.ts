/**
 * Only `usabl import figma` and `usabl drift design` call the Figma API, and only when a person
 * runs them. Nothing on the check, gate, or hook path can reach that code.
 *
 * - No module a verdict entry point can load, by a static import, a re-export, a type import, a
 *   dynamic import(), or require(), is in src/import/ or is src/drift/design.ts. The one path
 *   allowed is the dynamic import of each command's own module inside src/cli.ts.
 * - A dynamic import whose module the test cannot read from the source fails the test, except the
 *   two that load an optional package by name.
 * - The CLI names those modules only in dynamic imports, inside the two commands.
 * - fetch.ts is the one file in src/import/ and src/drift/ that calls fetch, and only the two
 *   commands import it.
 * - Only the two commands read FIGMA_TOKEN.
 *
 * The imports are read from the syntax tree, so an import inside a string or a comment is not one,
 * and one inside a function body is.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const VERDICT_ENTRY_POINTS = [
  'src/run.ts',
  'src/gate/index.ts',
  'src/deps/build.ts',
  'src/surfaces/stop-hook.ts',
  'src/surfaces/stop-hook-runner.ts',
  'src/surfaces/stop-hook-bin.ts',
  'src/surfaces/playwright-helper.ts',
  'src/surfaces/vite-plugin.ts',
  'src/surfaces/webpack-plugin.ts',
  'src/surfaces/overlay-host.ts',
  'src/surfaces/policy-enforce.ts',
  'src/surfaces/pr-comment.ts',
  'src/judge/prepare.ts',
  'src/index.ts',
  'src/cli.ts',
  'src/cli-bin.ts',
];

const NETWORK_MODULES = (file: string): boolean => file.startsWith('src/import/') || file === 'src/drift/design.ts';

// The one allowed path to the network modules: each command loads its own module by a dynamic
// import inside src/cli.ts. The test below pins that both sit inside their command.
const ALLOWED_NETWORK_EDGES = new Set(['src/cli.ts -> src/import/figma/cli.ts', 'src/cli.ts -> src/drift/design.ts']);

// Dynamic loads whose module is a variable. Each loads an optional npm package by name, never a
// file in this repository.
const ALLOWED_UNREAD_LOADS = new Set([
  'src/providers/engines/shared.ts: import(packageName)',
  'src/deps/build.ts: require(`${packageName}/package.json`)',
]);

type ImportKind = 'static' | 'dynamic';

interface ImportEdge {
  kind: ImportKind;
  // The specifier as written, or null when it is not a plain string.
  specifier: string | null;
  // The call as written, for a dynamic load whose specifier is not a plain string.
  text: string;
}

type ReadSource = (file: string) => Promise<string>;

const readRepoFile: ReadSource = (file) => readFile(join(ROOT, file), 'utf8');

function literalText(node: ts.Node | undefined): string | null {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/** Every import a file makes, of any kind, read from its syntax tree. */
function importsOf(file: string, source: string): ImportEdge[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      edges.push({ kind: 'static', specifier: literalText(node.moduleSpecifier), text: node.getText(tree) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      edges.push({ kind: 'static', specifier: literalText(node.moduleReference.expression), text: node.getText(tree) });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      edges.push({ kind: 'static', specifier: literalText(node.argument.literal), text: node.getText(tree) });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      edges.push({ kind: 'dynamic', specifier: literalText(node.arguments[0]), text: node.getText(tree).replace(/\/\*.*?\*\/\s*/gsu, '') });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return edges;
}

function resolveSpecifier(from: string, specifier: string): string {
  return relative(ROOT, resolve(ROOT, dirname(from), specifier)).replace(/\.js$/u, '.ts');
}

interface Reach {
  files: Set<string>;
  // Each edge into a network module that is not the allowed one, as "from -> to (kind)".
  networkEdges: string[];
  // Each dynamic load whose module the test cannot read, as "file: call".
  unread: string[];
}

/** Every file an entry point can load, by any kind of import, and what it found on the way. */
async function reach(entry: string, readSource: ReadSource = readRepoFile): Promise<Reach> {
  const files = new Set<string>();
  const networkEdges: string[] = [];
  const unread: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    if (files.has(file)) continue;
    files.add(file);
    for (const edge of importsOf(file, await readSource(file))) {
      if (edge.specifier === null) {
        const load = `${file}: ${edge.text}`;
        if (!ALLOWED_UNREAD_LOADS.has(load)) unread.push(load);
        continue;
      }
      if (!edge.specifier.startsWith('.')) {
        // A package or a Node.js module.
        continue;
      }
      const target = resolveSpecifier(file, edge.specifier);
      if (NETWORK_MODULES(target)) {
        const named = `${file} -> ${target}`;
        if (!(edge.kind === 'dynamic' && ALLOWED_NETWORK_EDGES.has(named))) {
          networkEdges.push(`${named} (${edge.kind})`);
        }
        continue;
      }
      if (!files.has(target)) queue.push(target);
    }
  }
  return { files, networkEdges, unread };
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
    .sort();
}

describe('the Figma API is reachable only from the import and drift design commands', () => {
  it.each(VERDICT_ENTRY_POINTS)('%s cannot load a Figma module by any kind of import', async (entry) => {
    const found = await reach(entry);
    expect(found.files.size).toBeGreaterThan(0);
    expect([...found.files].filter(NETWORK_MODULES)).toEqual([]);
    expect(found.networkEdges).toEqual([]);
    expect(found.unread).toEqual([]);
  });

  it('follows imports through files, so an import of the fetch would be found', async () => {
    const found = await reach('src/drift/design.ts');
    expect(found.networkEdges).toContain('src/drift/design.ts -> src/import/figma/fetch.ts (static)');
  });

  it('follows the CLI into the other commands it loads by dynamic import', async () => {
    const found = await reach('src/cli.ts');
    expect(found.files.has('src/measure/sensitivity/command.ts')).toBe(true);
    expect(found.files.has('src/history/ledger-report.ts')).toBe(true);
  });

  it('finds a dynamic import of the fetch added inside checkPage', async () => {
    const helper = 'src/surfaces/playwright-helper.ts';
    const source = await readRepoFile(helper);
    const opened = 'export async function checkPage(';
    expect(source).toContain(opened);
    const changed = source.replace(opened, `async function probe() { await import('../import/figma/fetch.js'); }\n${opened}`);
    const found = await reach(helper, (file) => (file === helper ? Promise.resolve(changed) : readRepoFile(file)));
    expect(found.networkEdges).toEqual([`${helper} -> src/import/figma/fetch.ts (dynamic)`]);
  });

  it('finds a require() of a Figma module and a dynamic import it cannot read', () => {
    const edges = importsOf(
      'x.ts',
      "const a = require('./import/figma/cli.js');\nconst b = await import(name);\n// await import('./import/x.js')\nconst c = \"import('./import/y.js')\";\n",
    );
    expect(edges).toEqual([
      { kind: 'dynamic', specifier: './import/figma/cli.js', text: "require('./import/figma/cli.js')" },
      { kind: 'dynamic', specifier: null, text: 'import(name)' },
    ]);
  });

  it('the CLI names the Figma modules only in dynamic imports', async () => {
    const source = await readFile(join(ROOT, 'src/cli.ts'), 'utf8');
    const mentions = [...source.matchAll(/['"]\.\/(?:import\/[^'"]*|drift\/design\.js)['"]/gu)];
    expect(mentions.map((match) => match[0]).sort()).toEqual(["'./drift/design.js'", "'./import/figma/cli.js'"]);
    for (const match of mentions) {
      const before = source.slice(Math.max(0, (match.index ?? 0) - 'await import('.length), match.index);
      expect(before, `${match[0]} is not loaded by a dynamic import`).toBe('await import(');
    }
  });

  it('only fetch.ts calls fetch, and only the two commands import it', async () => {
    const files = [...(await sourceFiles('src/import')), 'src/drift/design.ts', 'src/drift/routes.ts'];
    const callers: string[] = [];
    for (const file of files) {
      const source = await readFile(join(ROOT, file), 'utf8');
      if (/\bfetch\s*\(|fetchImpl\s*\(/u.test(source)) callers.push(file);
    }
    expect(callers).toEqual(['src/import/figma/fetch.ts']);

    const importers: string[] = [];
    for (const file of await sourceFiles('src')) {
      const edges = importsOf(file, await readRepoFile(file));
      if (edges.some((edge) => edge.specifier?.startsWith('.') === true && resolveSpecifier(file, edge.specifier) === 'src/import/figma/fetch.ts')) {
        importers.push(file);
      }
    }
    expect(importers.sort()).toEqual(['src/drift/design.ts', 'src/import/figma/cli.ts']);
  });

  it('only the two commands read FIGMA_TOKEN', async () => {
    const readers: string[] = [];
    for (const file of await sourceFiles('src')) {
      if ((await readFile(join(ROOT, file), 'utf8')).includes("'FIGMA_TOKEN'")) readers.push(file);
    }
    expect(readers).toEqual(['src/drift/design.ts', 'src/import/figma/cli.ts']);
  });
});
