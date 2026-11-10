/**
 * How every file usabl generates runs usabl: hooks, skills, the Cursor script, command, and
 * rule, and the brief step they open with.
 *
 * `npx usabl` downloads and runs whatever package holds the npm name usabl when usabl is not
 * installed, and with piped stdin, as a hook has, it does not ask first. `npm exec --no` runs the
 * usabl installed in the project, or a global one, and otherwise fails with no download.
 */

/** The command prefix every generated file runs usabl with. */
export const USABL_RUN = 'npm exec --no -- usabl';

/** The prefix earlier releases wrote. The installers take a file that holds it as their own. */
export const LEGACY_USABL_RUN = 'npx usabl';

/**
 * The one line a hook prints on stderr when usabl could not run. It says nothing was checked, so
 * it never reads as a pass, and how to install usabl. It goes inside double quotes in a shell
 * command, so it holds nothing the shell would expand.
 */
export const USABL_NOT_INSTALLED_LINE =
  'NOT verified - the usabl Stop hook did not run, so nothing was checked on this stop. ' +
  'usabl is not installed in this project, or it could not start. ' +
  'To fix: add usabl to this project as a dev dependency (npm install --save-dev with the path to your usabl copy), then stop again.';

/**
 * What a skill or a Cursor file tells the assistant when the command fails because usabl is not
 * installed. The assistant must not try to fix that by fetching a package of the same name. npm
 * prints one of two messages for that case, depending on what the registry holds under the name,
 * so the guidance names both.
 */
export const USABL_MISSING_GUIDANCE =
  'If npm says it could not determine the executable to run, or that npx canceled due to missing packages, ' +
  'usabl is not installed in this project. ' +
  'Tell the user. Do not install or download a package named usabl to work around it.';

/** Doctor's words for a generated file that still runs the old form. */
export function legacyDownloadDrift(what: string, reinstall: string): string {
  return (
    `Security drift: ${what} still runs "${LEGACY_USABL_RUN}". When usabl is not installed, that downloads and runs ` +
    `whatever package holds the npm name usabl. Run "${reinstall}" to rewrite it to "${USABL_RUN}", which never downloads.`
  );
}
