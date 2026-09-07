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
import {
  frameUntrustedBlock,
  scrubResult,
  UNTRUSTED_FRAME_END,
  UNTRUSTED_FRAME_START,
} from './scrub.js';

const COMMENT_MARKER = '<!-- usabl-report -->';
const STOP_CAP = 20;

// Page-derived text is written into a Markdown document that a forge renders, and Markdown is not
// a plain-text container. An HTML comment disappears when rendered, a character reference becomes
// a different character, an empty link disappears, and emphasis markers disappear. Any of those
// puts characters on the screen that are not in the string, which is enough to draw the
// untrusted-text frame marker out of text that is not the marker and hand the reader a frame that
// closes wherever the page wanted it to close.
//
// Every character a Markdown or HTML renderer could read as the start of markup is written as a
// numeric character reference. A reference renders as exactly the character it names and can never
// itself be read as markup, so a reader sees the page text as it really is and the renderer has
// nothing left to interpret.
//
// The emphasis and code characters have to be in this set, which is not obvious. They cannot
// delete text that is not their own delimiter, but that is enough: a delimiter pair wrapped around
// a piece of the marker vanishes and leaves the piece behind, so "UNTRUSTED *TEXT*" renders as
// "UNTRUSTED TEXT". A backslash does the same thing on its own, since it hides before the punctuation
// the marker already contains. Either one turns a string that is not the marker into the marker on
// screen, which is why none of them can be left through.
//
// The cost of the set is that a raw reader sees a reference where a file name had an underscore.
// That is worth paying, because the rendered text stays exactly what the page had.
const MARKUP_SIGNIFICANT = /[&<>[\]`*_~\\|]/g;

// Block markup is the other way a renderer changes what a reader sees. It does not delete
// characters, but it changes what the line is: page text that begins "# usabl report: VERIFIED"
// renders as a first-level heading, larger than the report's own headline, and a reader takes it
// for the verdict. Each piece of page text sits on its own line, and its line breaks were folded
// to spaces before it got here, so a block construct can only fire at the start of that line.
// This rule defends against, in GitHub Flavored Markdown:
//
//   a heading, "#" at the start of the line;
//   a bullet list item, "-", "+", or "*" at the start of the line;
//   a numbered list item, digits then "." or ")" at the start of the line;
//   a thematic break, "---", "***", "___", or the same with spaces between, alone on the line;
//   a setext underline, "===" or "---" alone on the line, which turns the line before it, the
//   frame's opening marker, into a heading.
//
// The first character of the marker is written as a reference, after any leading spaces, because
// a renderer allows up to three spaces of indent before block markup. A line whose first character
// is "&" is a paragraph line whatever follows, and the reference still renders as the character.
// "*" and "_" are already references from the inline set; they are listed here so this rule stands
// on its own.
const BLOCK_MARKER_AT_LINE_START = /^(\s*)([#\-+*=]|\d(?=\d*[.)]))/;

// Autolinks are the third way. A renderer turns "https://example.test/path", "www.example.test",
// and the "<...>" form into links a reader can click, and the page then chooses where a link in
// usabl's report goes. The "<" form is already covered by the inline set. The other two are
// matched on the raw bytes: the "://" of a scheme and the "www." of a bare host. A reference in
// place of the colon or the dot is not those bytes, so neither is matched, and it renders as the
// same character, so the reader still sees the address as text. Only a colon followed by "//" is
// touched, so a label like "why:" stays readable in the raw comment.
//
// Some forms are out of reach of a reference, and they are named here so the limit is not mistaken
// for an oversight. An email address, "user@example.test", and the "mailto:" and "xmpp:" forms are
// found by the Markdown renderer after references are decoded and adjacent text is joined. GitHub
// then runs its own filters on the rendered text: "@user" becomes a mention that notifies that
// user if they have access to the repository, "#123" becomes a link to that issue or pull request,
// and a commit SHA becomes a link to that commit. All of these read decoded text, so escaping
// cannot stop any of them. None can forge a verdict, close the untrusted-text frame, or leak
// engine data. The filters skip code spans, so wrapping page text in one is the mitigation, and
// that belongs to the sealed-text visual work rather than to this escape.
const SCHEME_COLON = /:(?=\/\/)/g;
const WWW_DOT = /(www)\./gi;

function reference(character: string): string {
  return `&#${character.codePointAt(0) ?? 0};`;
}

function escapeMarkdown(text: string): string {
  return text
    .replace(MARKUP_SIGNIFICANT, reference)
    .replace(SCHEME_COLON, reference)
    .replace(WWW_DOT, (_whole, www: string) => `${www}${reference('.')}`)
    .replace(
      BLOCK_MARKER_AT_LINE_START,
      (_whole, indent: string, marker: string) => `${indent}${reference(marker)}`,
    );
}

// A code span, fenced long enough that nothing inside it can end the span early. Character
// references are not interpreted inside a code span, so escaping is the wrong tool here: a value
// carrying a backtick has to be fenced away instead, or the rest of the line is read as markup.
function inlineCode(value: string): string {
  let longestRun = 0;
  let run = 0;
  for (const character of value) {
    run = character === '`' ? run + 1 : 0;
    longestRun = Math.max(longestRun, run);
  }
  const fence = '`'.repeat(longestRun + 1);
  // CommonMark drops one leading and one trailing space, which is how a span holds a backtick at
  // either end without the fence swallowing it.
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

// The framed block as Markdown lines. The two markers are engine text and the interface the
// overlay and the model match on, so they stay exactly as they are. Everything between them is
// page text and is escaped.
//
// A renderer joins consecutive lines of a paragraph with a space, so pieces could in principle be
// spliced into a marker across a line boundary. They cannot here: every piece after the first
// starts with an engine-authored label, so no join produces the marker text.
function framedMarkdownLines(pieces: string[]): string[] {
  return frameUntrustedBlock(pieces)
    .split('\n')
    .map((line) =>
      line === UNTRUSTED_FRAME_START || line === UNTRUSTED_FRAME_END ? line : escapeMarkdown(line),
    );
}

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
    `- sourceTree: ${inlineCode(result.receipt.sourceTree)}`,
    `- policyHash: ${inlineCode(result.receipt.policyHash)}`,
    `- runnerVersion: ${inlineCode(result.receipt.runnerVersion)}`,
    `- mintedAt: ${inlineCode(result.receipt.mintedAt)}`,
  ];
}

function renderConformance(result: Result): string[] {
  // This is a read-only three-bucket projection and never a score.
  const summary = computeConformance(result);
  const lines = [
    '### Conformance summary',
    `- schemaVersion: ${inlineCode(result.schemaVersion)}`,
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

// The source location and candidates as plain pieces for the untrusted frame. An app finding's
// source file can be read from a renderer-injected DOM attribute, so it is page-influenced and
// belongs inside the frame with the rest of the dynamic finding text. frameUntrustedBlock scrubs
// each piece, so these are passed raw rather than pre-neutralized.
function sourcePieces(
  source: DocsSourceMapping | undefined,
  appSource: AppSourceMapping | undefined,
): string[] {
  if (source !== undefined && source.file !== null) {
    const pieces = [`source: ${formatDocsSourceLocation(source)}`];
    if (source.candidates.length > 1) {
      pieces.push(`candidates: ${source.candidates.join(', ')}`);
    }
    return pieces;
  }
  if (appSource !== undefined && appSource.file !== null) {
    const pieces = [`source: ${formatAppSourceLocation(appSource)}`];
    if (appSource.candidates.length > 1) {
      pieces.push(`candidates: ${appSource.candidates.join(', ')}`);
    }
    return pieces;
  }
  if (appSource !== undefined && appSource.candidates.length > 0) {
    return [`candidates: ${appSource.candidates.join(', ')}`];
  }
  return [];
}

// One frame around every dynamic finding field. whatUserExperiences, why, the fix, and the source
// location can each carry page-derived or scanner-derived text: an axe rule with no curated note
// falls back to node.failureSummary for both why and fix, and an app source can be read from a
// renderer-injected DOM attribute. This comment is read by a model, so all of it is sealed as
// untrusted in one frame, and only the engine-authored header (severity, screen id, layer, rule)
// stays outside. That matches how the stop hook already frames its block.
function findingPieces(finding: Finding): string[] {
  return [
    finding.whatUserExperiences,
    `why: ${finding.why}`,
    ...sourcePieces(finding.docsSource, finding.appSource),
    `fix: ${fixOrAbsence(finding)}`,
  ];
}

function formatFinding(finding: Finding): string[] {
  const rule = neutralize(finding.rule);
  const layer = neutralize(finding.layer);
  const screenId = neutralize(finding.screenId);
  const severity = neutralize(finding.severity);
  const framed = framedMarkdownLines(findingPieces(finding));
  return [
    `- [${escapeMarkdown(severity)}] ${inlineCode(screenId)} - ${inlineCode(`${layer}/${rule}`)}`,
    ...framed.map((line) => `  ${line}`),
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
  const framed = framedMarkdownLines(findingPieces(finding));
  return [
    `- ${escapeMarkdown(headline)}`,
    `  - rule: ${inlineCode(screenId)} - ${inlineCode(`${layer}/${rule}`)} · ${escapeMarkdown(severity)}`,
    ...framed.map((line) => `  ${line}`),
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
    ...result.coverage.gaps.flatMap((gap) => {
      // A gap ref can be a page URL, and a reason can carry a browser or provider exception, both
      // page- or tool-derived, so they are sealed as untrusted for the model reading this comment.
      // The state is an engine enum and stays as the plain label.
      const framed = framedMarkdownLines([`ref: ${gap.ref}`, `reason: ${gap.reason}`]);
      return [`- (${escapeMarkdown(neutralize(gap.state))})`, ...framed.map((line) => `  ${line}`)];
    }),
  ];
}

// The announcement text for one stop, page-derived: tokens come from the accessibility tree and
// live regions, and the element-path fallback is a DOM selector. Returned raw; the caller frames
// it, and frameUntrustedBlock scrubs it, so it is not pre-neutralized here.
function stopAnnouncementText(stop: TranscriptStop): string {
  const nonLiveTokens = stop.announcement
    .filter((token) => token.kind !== 'live' && token.text !== null)
    .map((token) => token.text ?? '');
  const liveTokens = stop.announcement
    .filter((token) => token.kind === 'live' && token.text !== null)
    .map((token) => `[announced] ${token.text ?? ''}`);
  const pieces = [...nonLiveTokens, ...liveTokens].filter((token) => token.length > 0);
  return pieces.length > 0 ? pieces.join(', ') : stop.elementPath;
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
    lines.push(`#### ${inlineCode(neutralize(screen.screenId))}`);
    const capped = screen.stops.slice(0, STOP_CAP);
    for (const stop of capped) {
      const framed = framedMarkdownLines([stopAnnouncementText(stop)]);
      lines.push(`${stop.index + 1}.`, ...framed.map((line) => `  ${line}`));
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
