/**
 * Dev-only JSX source attribute injection for the overlay Vite plugin.
 * Adds data-source-file and data-source-line on component opening tags so scans can map findings
 * back to src/pages/Deployments.tsx:142 without guessing from import chains alone.
 */

const COMPONENT_TAG = /<([A-Z][A-Za-z0-9]*)(\s[^>]*?)?(\/?>)/g;

export function injectJsxSourceAttributes(code: string, file: string): string {
  const normalized = file.replace(/\\/g, "/");
  const lines = code.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index] ?? "";
    const transformed = line.replace(
      COMPONENT_TAG,
      (match, tag: string, attrs = "", close: string) => {
        if (attrs.includes("data-source-file=")) {
          return match;
        }
        return `<${tag}${attrs} data-source-file="${normalized}" data-source-line="${lineNumber}"${close}`;
      }
    );
    output.push(transformed);
  }
  return output.join("\n");
}

export function shouldInjectJsxSource(id: string): boolean {
  return /\.(tsx|jsx)$/u.test(id) && !/node_modules/u.test(id);
}
