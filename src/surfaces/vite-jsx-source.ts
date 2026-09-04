/**
 * Dev-only JSX source attribute injection for the overlay Vite plugin.
 * Adds data-source-file and data-source-line on opening tags so scans can map findings
 * back to src/pages/Deployments.tsx:142 without guessing from import chains alone.
 *
 * Two kinds of tags get the source attributes:
 *  - Capitalized component tags, for example <Button>.
 *  - Native HTML element tags, for example <button>, <input>, <a>, <img>.
 *
 * Native elements carry the source location so a barrier on a plain DOM element resolves to
 * the exact line, not just the file. Most barriers land on native elements, so this is where
 * jump-to-source pays off.
 *
 * The hard part is not corrupting TypeScript generics. A lowercase name inside a generic, for
 * example the "string" in useState<string>() or the "number" in Map<string, number>, must never
 * receive attributes. A capitalized name inside a generic, for example the "Foo" in Array<Foo>,
 * must not either. Two guards keep generics safe:
 *  1. The "<" must not sit right after an identifier character or a dot. A JSX opening tag starts
 *     after whitespace, "(", "{", ">", ",", or the start of a line, never right after a name.
 *     A generic like Array<Foo> always has an identifier letter right before the "<". This guard
 *     alone rejects every generic form.
 *  2. For lowercase tag names, the name must be a known HTML element. Generic type names such as
 *     string, number, boolean, or a user type are not HTML element names, so they are rejected.
 */

// Standard HTML element tag names. Lowercase JSX tags only get source attributes when the name is
// in this set. This is what keeps lowercase generic type names untouched: they are never HTML
// element names. script and style are deliberately left out; a data attribute on them does nothing
// useful and they never host a rendered barrier.
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

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

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

function isInjectableTag(tag: string): boolean {
  const first = tag.charAt(0);
  if (first >= 'A' && first <= 'Z') {
    // Capitalized name: a component tag. Guard 1 (the preceding-character check) already rejected
    // generics like Array<Foo>, so any tag reaching here is a real JSX component.
    return true;
  }
  // Lowercase name: inject only for known HTML elements. This rejects lowercase generic type
  // names such as string, number, and boolean.
  return HTML_ELEMENTS.has(tag);
}

// Read the tag name that starts right after a "<" at position start (start points at the first
// name character). Returns the name and the index just past it, or null when the following text is
// not a plain tag name.
function readTagName(code: string, start: number): { name: string; end: number } | null {
  if (start >= code.length || !/[A-Za-z]/.test(code[start] ?? '')) {
    return null;
  }
  let end = start + 1;
  while (end < code.length && /[A-Za-z0-9]/.test(code[end] ?? '')) {
    end += 1;
  }
  return { name: code.slice(start, end), end };
}

// Find the ">" that ends an opening tag whose attribute text starts at position attrStart. Strings
// and JSX expression containers ("{ ... }") are treated as opaque, so a ">" inside an arrow
// handler like onClick={() => go()} or inside a quoted value does not end the tag. Returns the
// index of the closing ">" and whether the tag is self-closing, or null when no close is found
// (an unterminated tag, which is left untouched).
function findTagClose(code: string, attrStart: number): { closeIndex: number; selfClosing: boolean } | null {
  let braceDepth = 0;
  let quote: string | null = null;
  for (let i = attrStart; i < code.length; i += 1) {
    const ch = code[i] ?? '';
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      continue;
    }
    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      continue;
    }
    if (ch === '>' && braceDepth === 0) {
      const selfClosing = code[i - 1] === '/';
      return { closeIndex: i, selfClosing };
    }
  }
  return null;
}

export function injectJsxSourceAttributes(code: string, file: string): string {
  const normalized = escapeHtmlAttribute(file.replace(/\\/g, "/"));
  let out = '';
  let scanFrom = 0;
  let cursor = 0;
  let lineNumber = 1;
  // Count newlines between the last emitted point and index target to keep line numbers exact.
  const advanceLine = (target: number): void => {
    for (let i = cursor; i < target; i += 1) {
      if (code[i] === '\n') {
        lineNumber += 1;
      }
    }
    cursor = target;
  };

  // Track lexical context so a "<" inside a string, template literal, or comment is never treated
  // as a tag. A "<button>" written inside a string or a comment is text, not JSX; injecting there
  // corrupts the module. Template literals push a context so a "${ ... }" interpolation returns to
  // normal code, where a real tag can still be injected. quote holds the active string delimiter
  // ('\'', '"', or '`'); commentMode is 'line' or 'block'; templateStack counts open "${" inside
  // each active template literal.
  let quote: string | null = null;
  let commentMode: 'line' | 'block' | null = null;
  const templateStack: number[] = [];

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i] ?? '';
    const next = code[i + 1] ?? '';

    if (commentMode === 'line') {
      if (ch === '\n') {
        commentMode = null;
      }
      continue;
    }
    if (commentMode === 'block') {
      if (ch === '*' && next === '/') {
        commentMode = null;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        // Skip the escaped character so an escaped delimiter does not end the string.
        i += 1;
        continue;
      }
      if (quote === '`' && ch === '$' && next === '{') {
        // Enter a template interpolation: code context resumes until the matching "}".
        templateStack.push(0);
        quote = null;
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    // In code context (this includes inside a template interpolation).
    if (ch === '/' && next === '/') {
      commentMode = 'line';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      commentMode = 'block';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (templateStack.length > 0) {
      // Balance braces so the interpolation ends at the right "}" and returns to the template.
      const top = templateStack.length - 1;
      const depth = templateStack[top] ?? 0;
      if (ch === '{') {
        templateStack[top] = depth + 1;
        continue;
      }
      if (ch === '}') {
        if (depth === 0) {
          templateStack.pop();
          quote = '`';
        } else {
          templateStack[top] = depth - 1;
        }
        continue;
      }
    }
    if (ch !== '<') {
      continue;
    }

    // Guard 1: a JSX opening tag never sits right after an identifier character or a dot. A
    // generic such as Array<Foo> or useState<string> always does, so this rejects them all.
    const prev = i > 0 ? (code[i - 1] ?? '') : '';
    if (prev !== '' && (isIdentifierChar(prev) || prev === '.')) {
      continue;
    }
    const named = readTagName(code, i + 1);
    if (named === null) {
      // Closing tags ("</div>"), fragments ("<>", "</>"), and non-tag "<" fall here.
      continue;
    }
    if (!isInjectableTag(named.name)) {
      continue;
    }
    const close = findTagClose(code, named.end);
    if (close === null) {
      continue;
    }
    const tagText = code.slice(i, close.closeIndex + 1);
    if (tagText.includes('data-source-file=')) {
      // Already injected; leave it untouched so repeated transforms stay stable.
      i = close.closeIndex;
      continue;
    }
    advanceLine(i);
    const tagLine = lineNumber;
    // Insert the attribute right before the closing ">" (or the "/" of "/>"). Keep exactly one
    // space between the last attribute and the injected one: if a space already sits there, for
    // example "<img src=\"y\" />", do not add a second.
    const insertAt = close.selfClosing ? close.closeIndex - 1 : close.closeIndex;
    const leadingSpace = code[insertAt - 1] === ' ' ? '' : ' ';
    out += code.slice(scanFrom, insertAt);
    out += `${leadingSpace}data-source-file="${normalized}" data-source-line="${tagLine}"`;
    scanFrom = insertAt;
    i = close.closeIndex;
  }
  out += code.slice(scanFrom);
  return out;
}

export function shouldInjectJsxSource(id: string): boolean {
  return /\.(tsx|jsx)$/u.test(id) && !/node_modules/u.test(id);
}
