/**
 * Docs-accessibility manifest discovery for the rendered-documentation scan surface.
 * The usabl.docs.json sidecar is what activates the docs surface, so its absence is a
 * clean "no docs surface" and returns null. Present-but-invalid content is a hard
 * failure: pretending a parse failure means "no docs" would silently rewrite the story.
 * This parser reads working-tree bytes only. Trusted-ref awareness is achieved by the
 * trust guard, which lists usabl.docs.json among the always-guarded policy files.
 */
import type { FsGlob } from '../contracts/index.js';

export interface DocsPageEntry {
  pageId: string;
  url: string;
  assemblyFile: string;
  sources: string[];
}

export interface DocsManifest {
  format: string;
  docsBaseUrl: string;
  builtRoot: string;
  buildCommand: string | null;
  pages: DocsPageEntry[];
  sharedGlobs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`usabl.docs.json ${field} must be a string`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, field: string): string {
  const str = expectString(value, field);
  if (str.length === 0) {
    throw new Error(`usabl.docs.json ${field} must be a non-empty string`);
  }
  return str;
}

function expectDocsPathUrl(value: unknown, field: string): string {
  const url = expectString(value, field);
  // Page urls are path suffixes under docsBaseUrl. Accepting a second origin here
  // would let discovery steer scans away from the built docs. Mirrors the route
  // manifest guard exactly.
  if (!url.startsWith('/') || url.includes('@')) {
    throw new Error(`usabl.docs.json ${field} must start with "/" and must not contain "@"`);
  }
  // Reject percent-encoded path metacharacters. Legitimate built-doc page paths
  // are plain slugs like /getting-started.html or /api/reference.html and never
  // contain percent-encoded dots or slashes. This is defense in depth: the
  // trusted-ref overlay neutralizes a diverged manifest, but we still reject
  // encoding at the input boundary before it can escape downstream decoding.
  if (/%2e|%2f|%5c/i.test(url)) {
    throw new Error(`usabl.docs.json ${field} must not contain percent-encoded path characters (%2e, %2f, %5c)`);
  }
  return url;
}

function expectSafeRelativePath(value: unknown, field: string): string {
  // Defense-in-depth: these strings are joined against the repo root later, so reject
  // absolute paths and any ".." segment before they can escape the working tree.
  const path = expectString(value, field);
  if (path.length === 0) {
    throw new Error(`usabl.docs.json ${field} must be a non-empty relative path`);
  }
  if (path.startsWith('/')) {
    throw new Error(`usabl.docs.json ${field} must be a repo-relative path, got absolute "${path}"`);
  }
  if (path.split('/').some((segment) => segment === '..')) {
    throw new Error(`usabl.docs.json ${field} must not contain a ".." path segment, got "${path}"`);
  }
  return path;
}

function expectBuildCommand(value: unknown): string | null {
  // Optional: absent (undefined) or explicit null both normalize to null.
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error('usabl.docs.json buildCommand must be a string or null');
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`usabl.docs.json ${field} must be an array`);
  }
  return value.map((entry, index) => expectString(entry, `${field}[${index}]`));
}

function expectSafeRelativePathArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`usabl.docs.json ${field} must be an array`);
  }
  return value.map((entry, index) => expectSafeRelativePath(entry, `${field}[${index}]`));
}

function assertUniquePageIds(pages: DocsPageEntry[]): void {
  // pageId is the scan identity. Duplicate ids on different urls can silently map one
  // rendered page to the wrong source closure and hide real coverage gaps.
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.pageId)) {
      throw new Error(`usabl.docs.json duplicate pageId: "${page.pageId}"`);
    }
    seen.add(page.pageId);
  }
}

function parseSidecar(raw: string): DocsManifest {
  // Corrupt sidecar data is a hard failure so callers cannot mistake it for "no docs".
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error('usabl.docs.json must be an object');
  }

  const format = expectNonEmptyString(parsed['format'], 'format');
  const docsBaseUrl = expectNonEmptyString(parsed['docsBaseUrl'], 'docsBaseUrl');
  const builtRoot = expectSafeRelativePath(parsed['builtRoot'], 'builtRoot');
  const buildCommand = expectBuildCommand(parsed['buildCommand']);

  const pagesRaw = parsed['pages'];
  if (!Array.isArray(pagesRaw)) {
    throw new Error('usabl.docs.json pages must be an array');
  }
  if (pagesRaw.length === 0) {
    throw new Error('usabl.docs.json pages must contain at least one entry');
  }
  const pages = pagesRaw.map((entry, index): DocsPageEntry => {
    if (!isRecord(entry)) {
      throw new Error(`usabl.docs.json pages[${index}] must be an object`);
    }
    return {
      pageId: expectNonEmptyString(entry['pageId'], `pages[${index}].pageId`),
      url: expectDocsPathUrl(entry['url'], `pages[${index}].url`),
      assemblyFile: expectSafeRelativePath(entry['assemblyFile'], `pages[${index}].assemblyFile`),
      sources: expectSafeRelativePathArray(entry['sources'], `pages[${index}].sources`),
    };
  });

  // sharedGlobs are glob patterns, not filesystem paths, so no ".." path-safety check.
  const sharedGlobs = expectStringArray(parsed['sharedGlobs'], 'sharedGlobs');

  return { format, docsBaseUrl, builtRoot, buildCommand, pages, sharedGlobs };
}

export async function parseDocsManifest(fs: FsGlob): Promise<DocsManifest | null> {
  // Presence of usabl.docs.json activates the docs surface. Absence is signalled by
  // readFile returning null, and that is a clean "no docs surface", not an error.
  // Genuine IO errors (for example EACCES) propagate as a hard failure: swallowing
  // them would silently rewrite the story exactly like pretending invalid means "no
  // docs". This mirrors parseConfiguredManifest in route-manifest.ts, which uses no
  // try/catch.
  const raw = await fs.readFile('usabl.docs.json');
  if (raw === null) {
    return null;
  }
  const manifest = parseSidecar(raw);
  assertUniquePageIds(manifest.pages);
  return manifest;
}
