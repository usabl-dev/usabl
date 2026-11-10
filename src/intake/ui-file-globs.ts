/**
 * When a config with an empty uiFileGlobs list is refused.
 *
 * With no UI globs, no changed file is a UI file, so every run reads as nothing to check and exits
 * 0, which reads like a pass on a run that looked at nothing. The one shape that may load is a
 * documentation-only repository: it has no UI files, and its usabl.docs.json says what to check.
 * That manifest must load and name at least one page. A file that is only there, empty or broken,
 * checks nothing.
 *
 * Every path that reads a config uses this one rule: the loader, the CI judge (which reads the
 * config and the manifest at the trusted ref), the Stop hook, and usabl doctor. This unit reads no
 * file itself, so each caller passes the manifest text from where its policy comes from.
 */
import type { UsablConfig } from '../contracts/index.js';
import { parseDocsManifestText } from '../coverage/docs-manifest.js';
import { operatorText } from './config-error.js';

/** The sentence every path prints when it refuses a config with an empty uiFileGlobs list. */
export function emptyUiFileGlobsRefusal(configPath: string): string {
  return (
    `${operatorText(configPath)} has an empty uiFileGlobs list, so usabl would read no change as a UI change, ` +
    'and every run would say nothing to check without looking at anything. usabl did not run. ' +
    'Set uiFileGlobs to the files that render your UI, such as src/**/*.tsx. ' +
    'If this repository holds documentation only, add a usabl.docs.json that loads and names at least one page, ' +
    'which "usabl init --docs" drafts.'
  );
}

/** Whether usabl.docs.json text loads and names at least one page. Absent text names none. */
export function docsManifestNamesAPage(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    return parseDocsManifestText(raw).pages.length > 0;
  } catch {
    return false;
  }
}

/**
 * The refusal for a config, or null when it may be used. `docsManifestRaw` is usabl.docs.json as
 * the caller's policy source holds it, or null when there is none or it could not be read.
 */
export function uiFileGlobsRefusal(
  config: Pick<UsablConfig, 'uiFileGlobs'>,
  docsManifestRaw: string | null,
  configPath: string,
): string | null {
  if (config.uiFileGlobs.length > 0 || docsManifestNamesAPage(docsManifestRaw)) return null;
  return emptyUiFileGlobsRefusal(configPath);
}
