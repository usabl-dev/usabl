/**
 * The words every surface uses when a scan ran in a browser without Chromium's sandbox. They are
 * usabl's own text, with nothing from a page or a config file in them, so they need no scrubbing.
 * This is disclosure only and never changes a verdict.
 */
export const SANDBOX_OFF_NOTICE =
  "the scan browser ran without Chromium's sandbox, because this system could not start it. " +
  'A page that exploits a browser bug could act with your rights. The verdict does not change. ' +
  'Run "usabl doctor" for the fix, or set "browserSandbox": "require" in usabl.config.json to refuse such scans.';
