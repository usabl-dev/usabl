/**
 * Pull request comment projection for a gated Result.
 * This unit renders markdown only.
 * It must never recompute findings, mint a verdict, or act as a second gate.
 */
import type {
  AppSourceMapping,
  DocsSourceMapping,
  Finding,
  Result,
  TranscriptStop,
  UsablConfig,
  Verdict,
} from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';
import { computeConformance } from '../output/conformance.js';
import { fixOrAbsence } from '../output/disclosure.js';
import {
  applyNoiseBudget,
  formatCollapsedGroupHeadline,
  resolveNoiseBudgetDefault,
  type CollapsedFindingGroup,
} from '../output/noise-budget.js';
import { formatAppSourceLocation, formatDocsSourceLocation } from '../output/source-location.js';
import { frameUntrusted, scrubResult } from './scrub.js';

const COMMENT_MARKER = '<!-- usabl-report -->';
const STOP_CAP = 20;

const HEADLINE: Record<Verdict, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

function projectHeadline(verdict: Verdict | null): string {
  // `verdict: null` is explicit idle disclosure from the gate, not a fallback verdict.
  const headline = verdict === null ? 'IDLE' : HEADLINE[verdict];
  return `## usabl report: ${headline}`;
}

function renderAccessibilitySplit(result: Result): string[] {
  if (result.verdict !== 'approval_required') {
    return [];
  }
  const accessibility =
    result.accessibilityVerdict === null ? 'IDLE' : HEADLINE[result.accessibilityVerdict];
  return [
    '',
    `Policy changed. Accessibility on this run: **${accessibility}**. Merge still needs a CODEOWNERS user approval of this head from someone other than the pull request author.`,
  ];
}

function renderReceipt(result: Result): string[] {
  if (result.receipt === null) {
    // Receipts are verified-only evidence. Missing receipt must never look like a pass.
    return ['_No receipt: run was not verified._'];
  }
  return [
    '### Receipt',
    `- sourceTree: \`${result.receipt.sourceTree}\``,
    `- policyHash: \`${result.receipt.policyHash}\``,
    `- runnerVersion: \`${result.receipt.runnerVersion}\``,
    `- mintedAt: \`${result.receipt.mintedAt}\``,
  ];
}

function renderConformance(result: Result): string[] {
  // This is a read-only three-bucket projection and never a score.
  const summary = computeConformance(result);
  const lines = [
    '### Conformance summary',
    `- schemaVersion: \`${result.schemaVersion}\``,
    `- deterministic: new ${summary.deterministic.newFailures}, carried ${summary.deterministic.carried}, waived ${summary.deterministic.waived}, fixed ${summary.deterministic.fixed}`,
    `- judged: model-judgment ${summary.judged.modelJudgment}, preview ${summary.judged.preview}`,
    `- not evaluated: unresolved files ${summary.notEvaluated.unresolvedFiles}, gaps ${summary.notEvaluated.gaps}`,
    `- blocked: ${summary.blocked ? 'yes' : 'no'}`,
  ];
  if (result.paidDownCount > 0) {
    const plural = result.paidDownCount === 1 ? 'entry' : 'entries';
    lines.push(`- floor debt resolved: ${result.paidDownCount} ${plural} (run usabl floor prune to re-arm)`);
  }
  return lines;
}

// The source location for a docs finding: file plus the author's construct when known, file plus
// the exact line when the renderer supplied one, else the file alone. Neutralized by the caller.
function renderSource(source: DocsSourceMapping | undefined, appSource: AppSourceMapping | undefined): string[] {
  if (source !== undefined && source.file !== null) {
    const lines = [`  - source: \`${neutralize(formatDocsSourceLocation(source))}\``];
    if (source.candidates.length > 1) {
      const listed = source.candidates.map((candidate) => `\`${neutralize(candidate)}\``).join(', ');
      lines.push(`  - candidates: ${listed}`);
    }
    return lines;
  }
  if (appSource !== undefined && appSource.file !== null) {
    const lines = [`  - source: \`${neutralize(formatAppSourceLocation(appSource))}\``];
    if (appSource.candidates.length > 1) {
      const listed = appSource.candidates.map((candidate) => `\`${neutralize(candidate)}\``).join(', ');
      lines.push(`  - candidates: ${listed}`);
    }
    return lines;
  }
  if (appSource !== undefined && appSource.candidates.length > 0) {
    const listed = appSource.candidates.map((candidate) => `\`${neutralize(candidate)}\``).join(', ');
    return [`  - candidates: ${listed}`];
  }
  return [];
}

function formatFinding(finding: Finding): string[] {
  const rule = neutralize(finding.rule);
  const layer = neutralize(finding.layer);
  const screenId = neutralize(finding.screenId);
  const severity = neutralize(finding.severity);
  // Docs findings speak the author's markup: a source line and a syntax-aware fix. App findings
  // have no docsSource and fall back to finding.fix.
  const source = finding.docsSource;
  // Most axe rules carry no curated note, so an absent fix is a real and common state. It is
  // stated rather than left blank, because a blank reads as a rendering fault.
  const fix = neutralize(fixOrAbsence(finding));
  const why = neutralize(finding.why);
  const framed = frameUntrusted(finding.whatUserExperiences).split('\n');
  return [
    `- [${severity}] \`${screenId}\` - \`${layer}/${rule}\``,
    ...framed.map((line) => `  ${line}`),
    `  - why: ${why}`,
    ...renderSource(source, finding.appSource),
    `  - fix: ${fix}`,
  ];
}

function renderFindingGroup(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) {
    return [`### ${title}`, '- none'];
  }
  return [`### ${title}`, ...findings.flatMap((finding) => formatFinding(finding))];
}

function formatCollapsedFinding(group: CollapsedFindingGroup): string[] {
  const finding = group.representative;
  const headline = formatCollapsedGroupHeadline(group);
  const rule = neutralize(finding.rule);
  const layer = neutralize(finding.layer);
  const screenId = neutralize(finding.screenId);
  const severity = neutralize(finding.severity);
  const source = finding.docsSource;
  const fix = neutralize(fixOrAbsence(finding));
  const why = neutralize(finding.why);
  const framed = frameUntrusted(finding.whatUserExperiences).split('\n');
  return [
    `- ${headline}`,
    `  - rule: \`${screenId}\` - \`${layer}/${rule}\` · ${severity}`,
    ...framed.map((line) => `  ${line}`),
    `  - why: ${why}`,
    ...renderSource(source, finding.appSource),
    `  - fix: ${fix}`,
  ];
}

function renderCollapsedFindings(findings: Finding[], config?: UsablConfig): string[] {
  const view = applyNoiseBudget(findings, resolveNoiseBudgetDefault(config), 'gating findings');
  // Render the collapsed view whenever the shown groups do not map one to one to findings, whether
  // that is from grouping repeated rules or from the budget hiding groups. Checking only collapsed
  // dropped the grouped-but-not-truncated case back to a raw, hint-less list.
  if (!view.grouped && !view.collapsed) {
    return [];
  }
  return [
    '### Findings (collapsed by rule)',
    ...view.groups.flatMap((group) => formatCollapsedFinding(group)),
    '',
    `_${view.showAllHint ?? ''}_`,
  ];
}

function renderCoverageGaps(result: Result): string[] {
  if (result.coverage.gaps.length === 0) {
    return ['### Coverage gaps', '- none'];
  }
  return [
    '### Coverage gaps',
    ...result.coverage.gaps.map(
      (gap) =>
        `- \`${neutralize(gap.ref)}\` (${neutralize(gap.state)}): ${neutralize(gap.reason)}`,
    ),
  ];
}

function formatStop(stop: TranscriptStop): string {
  const nonLiveTokens = stop.announcement
    .filter((token) => token.kind !== 'live' && token.text !== null)
    .map((token) => neutralize(token.text ?? ''));
  const liveTokens = stop.announcement
    .filter((token) => token.kind === 'live' && token.text !== null)
    .map((token) => `[announced] ${neutralize(token.text ?? '')}`);
  const pieces = [...nonLiveTokens, ...liveTokens].filter((token) => token.length > 0);
  return pieces.length > 0 ? pieces.join(', ') : neutralize(stop.elementPath);
}

function renderAnnouncements(result: Result): string[] {
  const lines = [
    '### Announcements (current run)',
    '_Screen reader announcements captured on this run. This is current state, not a before/after comparison against a base run._',
  ];

  for (const screen of result.screens) {
    if (screen.stops.length === 0) {
      continue;
    }
    lines.push(`#### \`${neutralize(screen.screenId)}\``);
    const capped = screen.stops.slice(0, STOP_CAP);
    for (const stop of capped) {
      lines.push(`${stop.index + 1}. ${formatStop(stop)}`);
    }
    if (screen.stops.length > STOP_CAP) {
      lines.push(`- showing first ${STOP_CAP} of ${screen.stops.length} stops`);
    }
  }

  if (lines.length === 2) {
    lines.push('- none');
  }

  return lines;
}

export function projectPrComment(result: Result, config?: UsablConfig): string {
  // Scrub first because PR comments are public egress for page-derived text.
  const safe = scrubResult(result);
  const deterministicNew = safe.findings.filter(
    (finding) => finding.evidenceClass === 'deterministic' && finding.status === 'new',
  );
  const deterministicCarried = safe.findings.filter(
    (finding) => finding.evidenceClass === 'deterministic' && finding.status === 'carried',
  );
  const advisory = safe.findings.filter(
    (finding) => finding.evidenceClass === 'preview' || finding.evidenceClass === 'model-judgment',
  );
  // Collapse only the gating (deterministic) lane. Advisory findings never gate, so they keep their
  // own labeled section and are never mixed into the collapsed barrier list.
  const gating = [...deterministicNew, ...deterministicCarried];
  const collapsedGating = renderCollapsedFindings(gating, config);
  const findingSections =
    collapsedGating.length > 0
      ? [...collapsedGating, '', ...renderFindingGroup('Advisory (non-gating)', advisory)]
      : [
          ...renderFindingGroup('New barriers', deterministicNew),
          '',
          ...renderFindingGroup('Known (carried)', deterministicCarried),
          '',
          ...renderFindingGroup('Advisory (non-gating)', advisory),
        ];

  return [
    COMMENT_MARKER,
    projectHeadline(safe.verdict),
    ...renderAccessibilitySplit(safe),
    '',
    ...renderReceipt(safe),
    '',
    ...renderConformance(safe),
    '',
    ...findingSections,
    '',
    ...renderCoverageGaps(safe),
    '',
    ...renderAnnouncements(safe),
  ].join('\n');
}
