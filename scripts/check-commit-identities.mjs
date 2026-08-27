import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUMAN_EMAIL = /^[^@\s]+@redhat\.com$/i;
const AUTOMATION_AUTHOR_EMAILS = new Set([
  '41898282+github-actions[bot]@users.noreply.github.com',
  '49699333+dependabot[bot]@users.noreply.github.com',
]);
const AUTOMATION_COMMITTER_EMAILS = new Set([
  ...AUTOMATION_AUTHOR_EMAILS,
  'noreply@github.com',
]);
const SHA = /^[0-9a-f]{40}$/;

function isApprovedEmail(email, automationEmails = new Set()) {
  const normalized = email.trim().toLowerCase();
  return HUMAN_EMAIL.test(normalized) || automationEmails.has(normalized);
}

function commitIdentityErrors(commit) {
  const errors = [];
  if (!isApprovedEmail(commit.authorEmail, AUTOMATION_AUTHOR_EMAILS)) {
    errors.push(`${commit.sha}: unapproved author email`);
  }
  if (!isApprovedEmail(commit.committerEmail, AUTOMATION_COMMITTER_EMAILS)) {
    errors.push(`${commit.sha}: unapproved committer email`);
  }
  for (const trailer of commit.message.matchAll(/^Co-authored-by:\s*.+<([^>]+)>\s*$/gim)) {
    if (!isApprovedEmail(trailer[1] ?? '')) {
      errors.push(`${commit.sha}: unapproved co-author email`);
    }
  }
  return errors;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
}

function checkLocalIdentity() {
  const name = git(['config', '--get', 'user.name']);
  const email = git(['config', '--get', 'user.email']);
  const useConfigOnly = git(['config', '--get', 'user.useConfigOnly']);
  const errors = [];
  if (name.trim().length === 0) errors.push('Git user.name is not configured.');
  if (!isApprovedEmail(email)) errors.push('Git user.email must use an approved Red Hat address.');
  if (useConfigOnly !== 'true') errors.push('Git user.useConfigOnly must be true.');
  return errors;
}

function readCommits(base, head) {
  if (!SHA.test(base) || !SHA.test(head)) {
    throw new Error('Commit range endpoints must be full lowercase Git object IDs.');
  }
  const output = git(['log', `${base}..${head}`, '--format=%H%x1f%ae%x1f%ce%x1f%B%x1e']);
  if (output.length === 0) throw new Error('Commit identity range contains no commits.');
  return output.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha = '', authorEmail = '', committerEmail = '', ...message] = record.split('\x1f');
    return { sha, authorEmail, committerEmail, message: message.join('\x1f') };
  });
}

function main(argv) {
  let errors;
  if (argv[0] === '--local' && argv.length === 1) {
    errors = checkLocalIdentity();
  } else if (argv[0] === '--range' && argv.length === 3) {
    errors = readCommits(argv[1], argv[2]).flatMap((commit) => commitIdentityErrors(commit));
  } else {
    process.stderr.write('Usage: check-commit-identities.mjs --local | --range <base-sha> <head-sha>\n');
    return 2;
  }
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    return 1;
  }
  process.stdout.write('Commit identities approved.\n');
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
