import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// README badge checker. The repository is private, so shields.io cannot read
// package.json and a dynamic badge would render as an error. The version badge
// therefore stays hardcoded and this check is what stops it drifting from
// package.json. It never guesses: an absent, duplicated, or unreadable badge is
// a failure with a stated reason, not a silent pass.

const README_NAME = 'README.md';
const PACKAGE_NAME = 'package.json';

// A version badge is a whole markdown image line whose alt text is `Version`.
const VERSION_BADGE_LINE = /^!\[Version\]\(\s*([^)\s]+)\s*\)\s*$/;

// shields.io static badges carry their fields in the path as
// `/badge/<label>-<message>-<color>`.
const BADGE_PATH = /^\/badge\/(.+)$/;

// shields.io escapes a literal dash in a field as `--` and a literal underscore
// as `__`. Split on single dashes only so a prerelease such as `1.0.0-rc.1`
// (written `1.0.0--rc.1`) still parses into three fields.
function splitBadgeFields(segment) {
  return segment
    .split(/(?<!-)-(?!-)/)
    .map((field) => field.replace(/--/g, '-').replace(/__/g, '_'));
}

function findVersionBadges(content) {
  const badges = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const match = VERSION_BADGE_LINE.exec(line);
    if (match) {
      badges.push({ lineNumber: index + 1, url: match[1] });
    }
  });
  return badges;
}

// Pull the version out of one badge URL, or say why it cannot be read.
function readBadgeVersion(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return { error: `badge target is not a URL: ${url}` };
  }

  const path = BADGE_PATH.exec(pathname);
  if (!path) {
    return { error: `badge URL is not a shields.io static badge: ${url}` };
  }

  const fields = splitBadgeFields(path[1]);
  if (fields.length !== 3 || fields[0].toLowerCase() !== 'version') {
    return { error: `badge URL is not a label-message-color version badge: ${url}` };
  }

  return { version: fields[1] };
}

async function checkReadmeBadges(root) {
  const packageJson = JSON.parse(await readFile(join(root, PACKAGE_NAME), 'utf8'));
  const packageVersion = packageJson.version;
  const readme = await readFile(join(root, README_NAME), 'utf8');
  const badges = findVersionBadges(readme);
  const problems = [];

  if (typeof packageVersion !== 'string' || packageVersion === '') {
    problems.push(`${PACKAGE_NAME}: no version field to check the badge against.`);
    return { packageVersion, badgeVersion: undefined, problems };
  }

  if (badges.length === 0) {
    problems.push(
      `${README_NAME}: no Version badge line found. Expected a line of the form ` +
        `![Version](https://img.shields.io/badge/version-${packageVersion}-blue?style=flat-square).`,
    );
    return { packageVersion, badgeVersion: undefined, problems };
  }

  if (badges.length > 1) {
    const lines = badges.map((badge) => badge.lineNumber).join(', ');
    problems.push(
      `${README_NAME}: ${badges.length} Version badge lines found (lines ${lines}). ` +
        'Keep exactly one so there is a single version to check.',
    );
    return { packageVersion, badgeVersion: undefined, problems };
  }

  const [badge] = badges;
  const parsed = readBadgeVersion(badge.url);
  if (parsed.error !== undefined) {
    problems.push(`${README_NAME}:${badge.lineNumber}: ${parsed.error}`);
    return { packageVersion, badgeVersion: undefined, problems };
  }

  if (parsed.version !== packageVersion) {
    problems.push(
      `${README_NAME}:${badge.lineNumber}: Version badge says ${parsed.version} but ` +
        `${PACKAGE_NAME} says ${packageVersion}. Edit the Version badge in ${README_NAME}.`,
    );
  }

  return { packageVersion, badgeVersion: parsed.version, problems };
}

async function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { packageVersion, problems } = await checkReadmeBadges(root);

  for (const problem of problems) {
    process.stdout.write(`${problem}\n`);
  }

  if (problems.length === 0) {
    process.stdout.write(
      `${README_NAME}: Version badge matches ${PACKAGE_NAME} (${packageVersion}).\n`,
    );
  }

  process.exit(problems.length > 0 ? 1 : 0);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `check-readme-badges failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  });
}

export { checkReadmeBadges, findVersionBadges, splitBadgeFields };
