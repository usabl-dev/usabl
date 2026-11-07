/**
 * The text projection of a task brief. It reads a Brief that `makeBrief` already scrubbed and
 * prints it for a person or an agent at a terminal. The done list is printed as the brief holds
 * it, so the text and the JSON say the same thing in the same words.
 *
 * A brief is a plan, not a verdict, and the first line says so. This unit never decides a verdict.
 */
import type { Brief, BriefCheck, BriefScreen } from '../brief/index.js';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function checkLabel(check: BriefCheck): string {
  return check.why === undefined ? check.id : `${check.id} (${check.why})`;
}

function screenLines(screen: BriefScreen): string[] {
  const applying = screen.checks.filter((check) => check.applies);
  const notApplying = screen.checks.filter((check) => !check.applies);
  const reached = screen.reachedBy.map((reach) =>
    reach.file === null ? `the change as a whole (${reach.via})` : `${reach.file} (${reach.via})`,
  );
  const lines = [
    `screen ${screen.id}: ${screen.url}`,
    `  reached by: ${reached.join(', ')}`,
    `  checks: ${applying.length === 0 ? 'none' : applying.map(checkLabel).join(', ')}`,
  ];
  if (notApplying.length > 0) {
    lines.push(`  not applying: ${notApplying.map(checkLabel).join(', ')}`);
  }
  if (screen.needsLiveScan) {
    lines.push('  needs a live scan in a browser');
  }
  return lines;
}

export function formatBrief(brief: Brief): string {
  const lead = brief.nothingToCheck
    ? `usabl brief: ${plural(brief.files.length, 'changed file')}, nothing to check. This is a plan, not a verdict.`
    : `usabl brief: ${plural(brief.files.length, 'changed file')} ${brief.files.length === 1 ? 'reaches' : 'reach'} ` +
      `${plural(brief.screens.length, 'screen')}. ` +
      'This is a plan, not a verdict.';
  const lines = [
    lead,
    `Policy read from the ${brief.policySource}. CI judges on the trusted ref, so a task that edits policy can get a different result there.`,
  ];
  for (const screen of brief.screens) {
    lines.push('', ...screenLines(screen));
  }
  if (brief.unresolved.length > 0 || brief.gaps.length > 0) {
    lines.push('');
    for (const entry of brief.unresolved) {
      lines.push(`unresolved: ${entry.file}: ${entry.why}`);
    }
    for (const gap of brief.gaps) {
      lines.push(`gap: ${gap.ref}: ${gap.why}`);
    }
  }
  lines.push('', 'Done when:', ...brief.done.map((line) => `  - ${line}`));
  return lines.join('\n');
}
