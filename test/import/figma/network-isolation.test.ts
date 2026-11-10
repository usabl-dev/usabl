/**
 * Only `usabl import figma` and `usabl drift design` call the Figma API, and only when a person
 * runs them. Nothing on the check, gate, or hook path can reach that code.
 *
 * - No module a verdict entry point can load, by a static import, a re-export, a type import, a
 *   dynamic import(), require(), or a call through a createRequire result, is in src/import/ or is
 *   src/drift/design.ts. The one path allowed is the dynamic import of each command's own module
 *   inside src/cli.ts.
 * - A dynamic import whose module the test cannot read from the source fails the test, except the
 *   two that load an optional package by name. The engine loader refuses at run time any name that
 *   is not a bare name, so it never loads a path or a URL. A bare name can still load a Node.js
 *   built-in module, or this package's own entry, which is built from src/index.ts, an entry point
 *   this test covers.
 * - No file in src/ uses eval (by its own name or as a property of globalThis, window, or self),
 *   Function, or new Worker, or imports the vm module, which run code the import graph cannot see.
 * - createRequire is followed under any name an import gives it.
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
  'src/deps/scanner-versions.ts: require(`${packageName}/package.json`)',
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

// The names a file calls createRequire by: its own name, and each name an import gives it, such as
// `import { createRequire as cr } from 'node:module'`.
// An import declaration can only be a top-level statement, so only those are read.
function createRequireNames(tree: ts.SourceFile): Set<string> {
  const names = new Set(['createRequire']);
  for (const statement of tree.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      if ((specifier.propertyName ?? specifier.name).text === 'createRequire') {
        names.add(specifier.name.text);
      }
    }
  }
  return names;
}

// A call of createRequire, by one of its names or as a property, such as module.createRequire(x).
function isCreateRequireCall(node: ts.Node, creators: ReadonlySet<string>): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && creators.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire')
  );
}

// The names a file binds to the result of a createRequire call. A call through one of them loads a
// module the way require() does.
function requireNames(tree: ts.SourceFile, creators: ReadonlySet<string>): Set<string> {
  const names = new Set(['require']);
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCreateRequireCall(node.initializer, creators)
    ) {
      names.add(node.name.text);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isCreateRequireCall(node.right, creators)
    ) {
      names.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return names;
}

/**
 * Every import a file makes, read from its syntax tree: a static import, a re-export, a type
 * import, a dynamic import(), a require() call, and a call made through a createRequire result,
 * whether it is bound to a name first or called at once.
 */
function importsOf(file: string, source: string): ImportEdge[] {
  return edgesOf(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

function edgesOf(tree: ts.SourceFile): ImportEdge[] {
  const creators = createRequireNames(tree);
  const loaders = requireNames(tree, creators);
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
        (ts.isIdentifier(node.expression) && loaders.has(node.expression.text)) ||
        isCreateRequireCall(node.expression, creators))
    ) {
      edges.push({ kind: 'dynamic', specifier: literalText(node.arguments[0]), text: node.getText(tree).replace(/\/\*.*?\*\/\s*/gsu, '') });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return edges;
}

// The names of the global object, through which eval can be reached as a property.
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

/**
 * Every place a file runs code from a string or starts another thread, which an import graph
 * cannot follow: a reference to eval (a direct or an indirect call, or a property of globalThis,
 * window, or self), a call of Function with or without new, new Worker, by its own name or as a
 * property such as worker_threads.Worker, and any import of the vm module.
 */
function codeRunnersOf(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const calleeName = (callee: ts.Expression): string | null =>
    ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
  const onGlobal = (target: ts.Expression): boolean => ts.isIdentifier(target) && GLOBAL_OBJECTS.has(target.text);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'eval' && onGlobal(node.expression)) {
      found.push(`${file}: ${node.getText(tree)}`);
    } else if (ts.isElementAccessExpression(node) && literalText(node.argumentExpression) === 'eval' && onGlobal(node.expression)) {
      found.push(`${file}: ${node.getText(tree)}`);
    } else if (ts.isIdentifier(node) && node.text === 'eval') {
      // A property name, such as page.eval, is not the global eval.
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodSignature(parent) && parent.name === node);
      if (!isPropertyName) found.push(`${file}: eval`);
    } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && calleeName(node.expression) === 'Function') {
      found.push(`${file}: ${node.getText(tree)}`);
    } else if (ts.isNewExpression(node) && calleeName(node.expression) === 'Worker') {
      found.push(`${file}: ${node.getText(tree)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  // The vm module runs code from a string in a context of its own. A file whose text never holds
  // the word vm cannot name it in an import, so only the others are read for imports.
  for (const edge of /\bvm\b/u.test(source) ? edgesOf(tree) : []) {
    if (edge.specifier === 'vm' || edge.specifier === 'node:vm') {
      found.push(`${file}: ${edge.text}`);
    }
  }
  return found;
}

// Places in src/ that run code from a string or start a thread, each with a reason. None today.
const ALLOWED_CODE_RUNNERS = new Set<string>([]);

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

  it('finds a load made through a createRequire result, bound to a name or called at once', () => {
    const edges = importsOf(
      'x.ts',
      [
        "import { createRequire } from 'node:module';",
        'const load = createRequire(import.meta.url);',
        "load('./import/figma/cli.js');",
        'let later;',
        'later = module.createRequire(here);',
        'later(name);',
        "createRequire(import.meta.url)('./import/figma/fetch.js');",
        '',
      ].join('\n'),
    );
    expect(edges.filter((edge) => edge.kind === 'dynamic')).toEqual([
      { kind: 'dynamic', specifier: './import/figma/cli.js', text: "load('./import/figma/cli.js')" },
      { kind: 'dynamic', specifier: null, text: 'later(name)' },
      { kind: 'dynamic', specifier: './import/figma/fetch.js', text: "createRequire(import.meta.url)('./import/figma/fetch.js')" },
    ]);
  });

  it('follows createRequire imported under another name', () => {
    const edges = importsOf(
      'x.ts',
      [
        "import { createRequire as cr } from 'node:module';",
        "cr(import.meta.url)('../import/figma/fetch.js');",
        'const load = cr(import.meta.url);',
        "load('../import/figma/cli.js');",
        '',
      ].join('\n'),
    );
    expect(edges.filter((edge) => edge.kind === 'dynamic')).toEqual([
      { kind: 'dynamic', specifier: '../import/figma/fetch.js', text: "cr(import.meta.url)('../import/figma/fetch.js')" },
      { kind: 'dynamic', specifier: '../import/figma/cli.js', text: "load('../import/figma/cli.js')" },
    ]);
  });

  it('finds a createRequire load of the fetch added inside checkPage', async () => {
    const helper = 'src/surfaces/playwright-helper.ts';
    const source = await readRepoFile(helper);
    const opened = 'export async function checkPage(';
    expect(source).toContain(opened);
    const changed = source.replace(
      opened,
      `import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nfunction probe() { load('../import/figma/fetch.js'); }\n${opened}`,
    );
    const found = await reach(helper, (file) => (file === helper ? Promise.resolve(changed) : readRepoFile(file)));
    expect(found.networkEdges).toEqual([`${helper} -> src/import/figma/fetch.ts (dynamic)`]);
  });

  it('no file in src/ runs code from a string or starts a thread, which the import graph cannot follow', async () => {
    const found: string[] = [];
    for (const file of await sourceFiles('src')) {
      found.push(...codeRunnersOf(file, await readRepoFile(file)).filter((site) => !ALLOWED_CODE_RUNNERS.has(site)));
    }
    expect(found).toEqual([]);
  });

  it('finds eval, Function, and Worker, and not a string, a comment, or a property name', () => {
    const found = codeRunnersOf(
      'x.ts',
      [
        "eval('1');",
        "(0, eval)('2');",
        "new Function('return 3');",
        "Function('return 4')();",
        "new Worker('./w.js');",
        "new worker_threads.Worker(file, { eval: true });",
        "const text = \"eval('5')\";",
        "// new Function('6')",
        'page.eval(x);',
        'const o = { eval: 1 };',
        '',
      ].join('\n'),
    );
    expect(found).toEqual([
      'x.ts: eval',
      'x.ts: eval',
      "x.ts: new Function('return 3')",
      "x.ts: Function('return 4')",
      "x.ts: new Worker('./w.js')",
      'x.ts: new worker_threads.Worker(file, { eval: true })',
    ]);
  });

  it('finds eval reached through the global object, and any load of the vm module', () => {
    const found = codeRunnersOf(
      'x.ts',
      [
        "globalThis.eval('1');",
        "window.eval('2');",
        "self.eval('3');",
        "globalThis['eval']('4');",
        "import vm from 'node:vm';",
        "import { runInThisContext } from 'vm';",
        "const later = await import('node:vm');",
        'page.eval(x);',
        '',
      ].join('\n'),
    );
    expect(found).toEqual([
      'x.ts: globalThis.eval',
      'x.ts: window.eval',
      'x.ts: self.eval',
      "x.ts: globalThis['eval']",
      "x.ts: import vm from 'node:vm';",
      "x.ts: import { runInThisContext } from 'vm';",
      "x.ts: import('node:vm')",
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
