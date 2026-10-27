import { describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';
import { injectJsxSourceAttributes, shouldInjectJsxSource } from '../../src/surfaces/vite-jsx-source.js';

const FILE = 'src/pages/Widget.tsx';

describe('injectJsxSourceAttributes: native HTML elements', () => {
  it('injects on a native button with the opening-tag line number', () => {
    const code = ['const x = 1;', '<button>Save</button>'].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    expect(out).toContain(`<button data-source-file="${FILE}" data-source-line="2">Save</button>`);
  });

  it('injects on a native input with attributes and self-closing slash', () => {
    const code = ['<input type="text" />'].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    expect(out).toContain(`<input type="text" data-source-file="${FILE}" data-source-line="1" />`);
  });

  it('injects on a native anchor', () => {
    const code = ['', '', '<a href="x">go</a>'].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    expect(out).toContain(`<a href="x" data-source-file="${FILE}" data-source-line="3">go</a>`);
  });

  it('injects on a self-closing native img', () => {
    const code = ['<img src="y" />'].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    expect(out).toContain(`<img src="y" data-source-file="${FILE}" data-source-line="1" />`);
  });
});

describe('injectJsxSourceAttributes: TypeScript generic safety', () => {
  it('leaves all generic lines byte-for-byte unchanged', () => {
    const genericLines = [
      'const [v, setV] = useState<string>();',
      'const m: Map<string, number> = new Map();',
      'const a: Array<Foo> = [];',
      'const ref = useRef<HTMLButtonElement>(null);',
      'async function go(): Promise<void> {}',
    ];
    const code = genericLines.join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    const outLines = out.split('\n');
    for (let i = 0; i < genericLines.length; i += 1) {
      expect(outLines[i]).toBe(genericLines[i]);
    }
    expect(out).not.toContain('data-source-file');
  });

  it('does not inject on a lowercase non-element name that forms a pseudo-tag', () => {
    // A chained comparison "a <zz && c> d" contains "<zz && c>", which the scanner sees as a
    // "<name ...>" shape. Guard 1 (the character before "<") does not reject it: the "<" follows
    // a space. Only the HTML-element allowlist keeps "zz" from being treated as a tag. Removing
    // the allowlist turns this red, which is the mutation the spec asks for.
    const line = 'const ok = a <zz && c> d;';
    const out = injectJsxSourceAttributes(line, FILE);
    expect(out).toBe(line);
    expect(out).not.toContain('data-source-file');
  });
});

describe('injectJsxSourceAttributes: existing behavior preserved', () => {
  it('still injects on capitalized component tags', () => {
    const code = ['<Button label="x" />'].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    expect(out).toContain(`<Button label="x" data-source-file="${FILE}" data-source-line="1" />`);
  });

  it('is idempotent when data-source-file is already present', () => {
    const code = [`<button data-source-file="${FILE}" data-source-line="1">Save</button>`].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    expect(out).toBe(code);
  });

  it('does not touch closing tags or fragments', () => {
    const code = ['</div>', '<>', '</>'].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    const outLines = out.split('\n');
    expect(outLines[0]).toBe('</div>');
    expect(outLines[1]).toBe('<>');
    expect(outLines[2]).toBe('</>');
    expect(out).not.toContain('data-source-file');
  });
});

describe('injectJsxSourceAttributes: mixed realistic TSX', () => {
  it('injects JSX, leaves generics untouched', () => {
    const code = [
      'export function Widget() {',
      '  const [name, setName] = useState<string>("");',
      '  const map: Map<string, number> = new Map();',
      '  return (',
      '    <section>',
      '      <Header title="hi" />',
      '      <button onClick={() => setName("x")}>Save</button>',
      '      <input value={name} />',
      '    </section>',
      '  );',
      '}',
    ].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    const outLines = out.split('\n');
    // generics untouched
    expect(outLines[1]).toBe('  const [name, setName] = useState<string>("");');
    expect(outLines[2]).toBe('  const map: Map<string, number> = new Map();');
    // native + component injected with correct line numbers
    expect(outLines[4]).toContain(`<section data-source-file="${FILE}" data-source-line="5">`);
    expect(outLines[5]).toContain(`<Header title="hi" data-source-file="${FILE}" data-source-line="6" />`);
    expect(outLines[6]).toContain('data-source-line="7"');
    expect(outLines[6]).toContain(`onClick={() => setName("x")} data-source-file="${FILE}" data-source-line="7">Save</button>`);
    expect(outLines[7]).toContain(`<input value={name} data-source-file="${FILE}" data-source-line="8" />`);
  });

  it('produces output that still parses as valid TSX', () => {
    const code = [
      'export function Widget() {',
      '  const [name, setName] = useState<string>("");',
      '  const map: Map<string, number> = new Map();',
      '  const ref = useRef<HTMLButtonElement>(null);',
      '  return (',
      '    <section>',
      '      <Header title="hi" />',
      '      <button ref={ref} onClick={() => setName("x")}>{name}</button>',
      '      <input value={name} />',
      '    </section>',
      '  );',
      '}',
    ].join('\n');
    const out = injectJsxSourceAttributes(code, FILE);
    // esbuild throws on a parse error, so a clean return proves the transformed output is
    // still valid TSX with the generics intact.
    expect(() =>
      transformSync(out, { loader: 'tsx', jsx: 'automatic' }),
    ).not.toThrow();
  });
});

describe('injectJsxSourceAttributes: hostile path escaping', () => {
  it('escapes a double quote in the path so it cannot open a new attribute', () => {
    const hostile = 'src/evil" onmouseover="steal(document.cookie)" x=".tsx';
    const out = injectJsxSourceAttributes('<button>Save</button>', hostile);
    // The quote must be escaped, so no raw onmouseover attribute leaks out.
    expect(out).toContain('&quot;');
    // The hostile text must never split into its own attribute: no raw quote-space-onmouseover.
    expect(out).not.toContain('" onmouseover="');
    // The whole injected data-source-file value stays one escaped string.
    expect(out).toContain('data-source-file="src/evil&quot; onmouseover=&quot;steal(document.cookie)&quot; x=&quot;.tsx"');
    // esbuild parses the output; a real onmouseover prop must not appear in the compiled tag.
    const compiled = transformSync(out, { loader: 'tsx', jsx: 'automatic' }).code;
    expect(compiled).not.toMatch(/onmouseover\s*:/i);
    expect(compiled).not.toMatch(/onMouseOver/);
  });

  it('escapes angle brackets and ampersands in the path', () => {
    const hostile = 'src/a&b<c>d.tsx';
    const out = injectJsxSourceAttributes('<button>x</button>', hostile);
    expect(out).toContain('data-source-file="src/a&amp;b&lt;c&gt;d.tsx"');
    expect(out).not.toContain('<c>d.tsx');
    expect(() =>
      transformSync(out, { loader: 'tsx', jsx: 'automatic' }),
    ).not.toThrow();
  });
});

describe('injectJsxSourceAttributes: no injection inside string, template, or comment context', () => {
  const FILE_TSX = 'src/pages/Widget.tsx';

  it('leaves a tag inside a double-quoted string untouched and keeps valid TSX', () => {
    const code = 'const HELP = "Use a <button> to submit"; export const A = () => <p>{HELP}</p>;';
    const out = injectJsxSourceAttributes(code, FILE_TSX);
    // The string literal must be byte-for-byte unchanged.
    expect(out).toContain('"Use a <button> to submit"');
    // The real <p> tag still gets injected.
    expect(out).toContain('<p data-source-file=');
    // The whole module still compiles.
    expect(() =>
      transformSync(out, { loader: 'tsx', jsx: 'automatic' }),
    ).not.toThrow();
  });

  it('leaves a tag inside a single-quoted string untouched', () => {
    const code = "const s = 'a <button> b';";
    const out = injectJsxSourceAttributes(code, FILE_TSX);
    expect(out).toBe(code);
    expect(out).not.toContain('data-source-file');
  });

  it('leaves a tag inside a template literal untouched', () => {
    const code = 'const t = `a <button> b`;';
    const out = injectJsxSourceAttributes(code, FILE_TSX);
    expect(out).toBe(code);
    expect(out).not.toContain('data-source-file');
  });

  it('leaves a tag inside a line comment untouched', () => {
    const code = '// render a <button> here';
    const out = injectJsxSourceAttributes(code, FILE_TSX);
    expect(out).toBe(code);
    expect(out).not.toContain('data-source-file');
  });

  it('leaves a tag inside a block comment untouched', () => {
    const code = '/* a <button> in a block comment */';
    const out = injectJsxSourceAttributes(code, FILE_TSX);
    expect(out).toBe(code);
    expect(out).not.toContain('data-source-file');
  });

  it('still injects real JSX in a template literal interpolation', () => {
    // Inside ${ ... } the parser is back in code context, so a real tag there gets injected.
    const code = 'const t = `${(<button>x</button>)}`;';
    const out = injectJsxSourceAttributes(code, FILE_TSX);
    expect(out).toContain('<button data-source-file=');
  });
});

describe('shouldInjectJsxSource', () => {
  it('accepts tsx and jsx outside node_modules', () => {
    expect(shouldInjectJsxSource('/app/src/Widget.tsx')).toBe(true);
    expect(shouldInjectJsxSource('/app/src/Widget.jsx')).toBe(true);
    expect(shouldInjectJsxSource('/app/node_modules/x/Widget.tsx')).toBe(false);
    expect(shouldInjectJsxSource('/app/src/Widget.ts')).toBe(false);
  });
});

describe('injectJsxSourceAttributes: elements with type arguments and other tag shapes', () => {
  // The plugin runs before the host JSX transform, so it sees raw TSX. A component used with a type
  // argument, such as <PageWizard<Data>>, used to get the attributes inside the type argument list.
  // The file then failed to parse and the dev server answered 500 for every module importing it.
  const TSX = 'src/pages/Wizard.tsx';
  const injected = (line: number): string => `data-source-file="${TSX}" data-source-line="${line}"`;
  const compiles = (out: string): void => {
    expect(() => transformSync(out, { loader: 'tsx', jsx: 'automatic' })).not.toThrow();
  };

  it('puts the attributes outside the type argument list of a generic element', () => {
    const code = [
      'export const W = () => (',
      '  <PageWizard<SubscriptionWizardData> title="Subscribe">',
      '    <p>Step</p>',
      '  </PageWizard>',
      ');',
    ].join('\n');
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out).toContain(`<PageWizard<SubscriptionWizardData> title="Subscribe" ${injected(2)}>`);
    expect(out).toContain(`<p ${injected(3)}>Step</p>`);
    compiles(out);
  });

  it('puts the attributes after nested type arguments', () => {
    const code = 'export const W = () => <A<B<C>>>text</A>;';
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out).toBe(`export const W = () => <A<B<C>> ${injected(1)}>text</A>;`);
    compiles(out);
  });

  it('handles a generic element inside a conditional expression', () => {
    const code = [
      'export const W = ({ open }: { open: boolean }) => (',
      '  <div>',
      '    {open ? <Modal<ModalProps> isOpen /> : <Empty<string> />}',
      '  </div>',
      ');',
    ].join('\n');
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out).toContain(`<Modal<ModalProps> isOpen ${injected(3)} />`);
    expect(out).toContain(`<Empty<string> ${injected(3)} />`);
    compiles(out);
  });

  it('puts the attributes outside the type argument list of a self-closing generic element', () => {
    const code = 'export const W = () => <Select<Option> value={v} onChange={(x: Option) => set(x)} />;';
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out).toBe(
      `export const W = () => <Select<Option> value={v} onChange={(x: Option) => set(x)} ${injected(1)} />;`,
    );
    compiles(out);
  });

  it('leaves a fragment alone and injects the elements inside it', () => {
    const code = 'export const W = () => (<><Header<Item> /><span>x</span></>);';
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out).toBe(
      `export const W = () => (<><Header<Item> ${injected(1)} /><span ${injected(1)}>x</span></>);`,
    );
    compiles(out);
  });

  it('injects on a member-expression tag after the full name', () => {
    const code = 'export const W = () => <Foo.Bar.Baz<T> label="x"><Foo.Item /></Foo.Bar.Baz>;';
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out).toBe(
      `export const W = () => <Foo.Bar.Baz<T> label="x" ${injected(1)}><Foo.Item ${injected(1)} /></Foo.Bar.Baz>;`,
    );
    compiles(out);
  });

  it('leaves a namespaced tag unchanged and still injects its neighbors', () => {
    // A namespaced name such as svg:rect is neither a component nor a known HTML element.
    const code = 'export const W = () => <svg><svg:rect width="1" /></svg>;';
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out).toBe(`export const W = () => <svg ${injected(1)}><svg:rect width="1" /></svg>;`);
    compiles(out);
  });

  it('does not treat a generic arrow function or a type assertion as a tag', () => {
    const code = [
      'const id = <T,>(value: T): T => value;',
      'const pick = <K extends keyof Props>(key: K) => key;',
      'export const W = () => <Grid<Row> rows={id<Row[]>([])} />;',
    ].join('\n');
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out.split('\n')[0]).toBe('const id = <T,>(value: T): T => value;');
    expect(out.split('\n')[1]).toBe('const pick = <K extends keyof Props>(key: K) => key;');
    expect(out.split('\n')[2]).toBe(`export const W = () => <Grid<Row> rows={id<Row[]>([])} ${injected(3)} />;`);
    compiles(out);
  });

  it('passes a file it cannot parse through unchanged and reports it', () => {
    const code = 'export const W = () => <div>unclosed;\n';
    const reported: string[] = [];
    const out = injectJsxSourceAttributes(code, TSX, (file) => reported.push(file));
    expect(out).toBe(code);
    expect(reported).toEqual([TSX]);
  });
});

describe('injectJsxSourceAttributes: attribute order and other syntax', () => {
  const TSX = 'src/pages/Widget.tsx';
  const injected = (line: number, file = TSX): string => `data-source-file="${file}" data-source-line="${line}"`;

  it('puts the attributes after a spread, so a spread cannot replace the element location', () => {
    // Props spread onto an element can carry a data-source-file from the parent. In JSX the last
    // attribute wins, so the element's own location has to come after the spread.
    const code = 'export const B = (rest: Props) => <button {...rest}>Go</button>;';
    const out = injectJsxSourceAttributes(code, TSX);
    expect(out).toBe(`export const B = (rest: Props) => <button {...rest} ${injected(1)}>Go</button>;`);
    const compiled = transformSync(out, { loader: 'tsx', jsx: 'automatic' }).code;
    expect(compiled.indexOf('...rest')).toBeLessThan(compiled.indexOf('"data-source-file"'));
  });

  it('injects in a .tsx file that uses decorators', () => {
    const code = ['@observer', 'class Store {}', 'export const A = () => <div>x</div>;'].join('\n');
    const reported: string[] = [];
    const out = injectJsxSourceAttributes(code, TSX, (file) => reported.push(file));
    expect(reported).toEqual([]);
    expect(out).toContain(`<div ${injected(3)}>x</div>`);
  });

  it('injects in a .jsx file that uses Flow types', () => {
    const JSX = 'src/pages/Widget.jsx';
    const code = ['// @flow', 'type Props = { title: string };', 'export const A = (props: Props) => <h1>{props.title}</h1>;'].join('\n');
    const reported: string[] = [];
    const out = injectJsxSourceAttributes(code, JSX, (file) => reported.push(file));
    expect(reported).toEqual([]);
    expect(out).toContain(`<h1 ${injected(3, JSX)}>{props.title}</h1>`);
  });
});
