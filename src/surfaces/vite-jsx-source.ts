/**
 * Dev-only JSX source attribute injection for the overlay Vite plugin.
 * Adds data-source-file and data-source-line on opening tags so scans can map findings
 * back to src/pages/Deployments.tsx:142 without guessing from import chains alone.
 *
 * Two kinds of tags get the source attributes:
 *  - Component tags: a capitalized name such as <Button>, or a member name such as <Foo.Bar>.
 *  - Native HTML element tags, for example <button>, <input>, <a>, <img>.
 *
 * Native elements carry the source location so a barrier on a plain DOM element resolves to
 * the exact line, not just the file. Most barriers land on native elements, so this is where
 * jump-to-source pays off.
 *
 * The file is parsed, and tags are taken from the syntax tree, not from the text. Text matching
 * cannot tell a tag from a generic: it put the attributes inside the type argument list of
 * <PageWizard<Data>>, and inside the type parameters of a generic arrow function such as
 * <T,>(value: T) => value, and the file no longer parsed. The tree says exactly where each opening
 * tag's name and type arguments end, and the attributes go right there, which is always valid JSX.
 * A string, a comment, or a type is never a tag in the tree, so none of them is touched.
 *
 * A file the parser cannot read is returned unchanged. The caller is told, so it can warn, but
 * the file is served as written: a missing source hint is a small loss, and a dev server error on
 * every module that imports the file is not.
 */
import { child, children, lineOf, parseSource, syntaxForFile, walk, type AstNode } from '../primitives/source-ast.js';

// Standard HTML element tag names. Lowercase JSX tags only get source attributes when the name is
// in this set, so a custom element or an unknown lowercase name is left as written. script and
// style are deliberately left out; a data attribute on them does nothing useful and they never
// host a rendered barrier.
const HTML_ELEMENTS = new Set<string>([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio',
  'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
  'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html',
  'i', 'iframe', 'img', 'input', 'ins',
  'kbd',
  'label', 'legend', 'li', 'link',
  'main', 'map', 'mark', 'menu', 'meta', 'meter',
  'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output',
  'p', 'param', 'picture', 'pre', 'progress',
  'q',
  'rp', 'rt', 'ruby',
  's', 'samp', 'search', 'section', 'select', 'slot', 'small', 'source', 'span',
  'strong', 'sub', 'summary', 'sup', 'svg',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'tr', 'track',
  'u', 'ul',
  'var', 'video',
  'wbr',
]);

// Escape a path before it goes into a double-quoted HTML attribute value. The repo-relative path
// is not trusted: a file name may contain a double quote, which would otherwise close the value
// and let following text become live attributes. Escaping the four characters below keeps the path
// as data. The line number is numeric, so it needs no escaping.
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Whether an opening tag's name gets the attributes. A namespaced name such as svg:rect is neither
// a component nor an HTML element, so it is left alone.
function isInjectableName(name: AstNode): boolean {
  if (name.type === 'JSXMemberExpression') {
    // <Foo.Bar> is always a component reference.
    return true;
  }
  if (name.type !== 'JSXIdentifier' || typeof name['name'] !== 'string') {
    return false;
  }
  const tag = name['name'];
  const first = tag.charAt(0);
  if (first >= 'A' && first <= 'Z') {
    return true;
  }
  // Lowercase name: inject only for known HTML elements, not for custom elements or other names.
  return HTML_ELEMENTS.has(tag);
}

function hasSourceAttribute(opening: AstNode): boolean {
  return children(opening, 'attributes').some((attribute) => {
    const name = attribute.type === 'JSXAttribute' ? child(attribute, 'name') : null;
    return name?.type === 'JSXIdentifier' && name['name'] === 'data-source-file';
  });
}

// Where the attributes go: right after the tag name, or after its type argument list when it has
// one. The parser stores that list as typeParameters in this major version and as typeArguments
// in the next, so both are read.
function insertionPoint(opening: AstNode): number | null {
  const typeArguments = child(opening, 'typeArguments') ?? child(opening, 'typeParameters');
  const end = typeArguments?.end ?? child(opening, 'name')?.end;
  return typeof end === 'number' ? end : null;
}

/**
 * Returns the code with source attributes on every component and HTML element opening tag.
 *
 * `file` is the repo-relative path written into the attribute. Its extension also decides whether
 * the file is parsed as TypeScript. When the code does not parse, it is returned unchanged and
 * `onUnreadable` is called with the file.
 */
export function injectJsxSourceAttributes(
  code: string,
  file: string,
  onUnreadable?: (file: string) => void,
): string {
  const parsed = parseSource(code, syntaxForFile(file));
  if (!parsed.ok) {
    onUnreadable?.(file);
    return code;
  }
  const normalized = escapeHtmlAttribute(file.replace(/\\/g, '/'));
  const insertions: Array<{ at: number; line: number }> = [];
  walk(parsed.program, (node) => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    const name = child(node, 'name');
    if (name === null || !isInjectableName(name) || hasSourceAttribute(node)) {
      // Already injected tags are left as they are, so repeated transforms stay stable.
      return;
    }
    const at = insertionPoint(node);
    const line = lineOf(node);
    if (at !== null && line !== null) {
      insertions.push({ at, line });
    }
  });
  // Every offset points into the original code, so the output is built from slices of that code,
  // in offset order. No insertion shifts another one, and the cost stays linear in the file size.
  insertions.sort((a, b) => a.at - b.at);
  const pieces: string[] = [];
  let cursor = 0;
  for (const { at, line } of insertions) {
    pieces.push(code.slice(cursor, at), ` data-source-file="${normalized}" data-source-line="${line}"`);
    cursor = at;
  }
  pieces.push(code.slice(cursor));
  return pieces.join('');
}

export function shouldInjectJsxSource(id: string): boolean {
  return /\.(tsx|jsx)$/u.test(id) && !/node_modules/u.test(id);
}
