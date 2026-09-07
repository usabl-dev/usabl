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
  formatCollapsedGroupCount,
  resolveNoiseBudgetDefault,
  type CollapsedFindingGroup,
} from '../output/noise-budget.js';
import { formatAppSourceLocation, formatDocsSourceLocation } from '../output/source-location.js';
import { describeVerdict, formatVerdictWord } from '../output/verdict-line.js';
import {
  scrubResult,
  scrubString,
  UNTRUSTED_FRAME_END,
  UNTRUSTED_FRAME_START,
} from './scrub.js';

const COMMENT_MARKER = '<!-- usabl-report -->';
const STOP_CAP = 20;

// Two kinds of text reach this Markdown document, and each gets its own defense.
//
// Page-derived text, everything inside an untrusted frame, is written as a code span. Inside a
// code span Markdown is inert: no character reference, HTML, emphasis, link, or block construct
// is read, so nothing a renderer does can delete or add characters and draw the frame marker out
// of text that is not the marker. GitHub's post-render filters, which turn an email address,
// "@user", "#123", or a commit id into a link, a mention, or a notification, run on the rendered
// text and skip code spans. Escaping could never have stopped those, because they read decoded
// text; the span is the mitigation the threat model names. The span is fenced with one more
// backtick than the longest run inside it, so a value cannot close its own span.
//
// Provider-authored text that prints as prose outside the frame, a rule or layer name and a
// severity in a headline, and a gap state, is escaped instead. Every character a renderer could
// read as the start of markup is written as a numeric character reference, which renders as
// exactly the character it names, so the report's own lines cannot be read as markup and still
// read as prose. The set includes the emphasis and code characters: a delimiter pair wrapped
// around a piece of text vanishes and leaves the piece behind, so "UNTRUSTED *TEXT*" renders as
// "UNTRUSTED TEXT", and a backslash hides before punctuation the same way.
const MARKUP_SIGNIFICANT = /[&<>[\]`*_~\\|]/g;

// Block markup changes what a line is rather than what it says: a line that begins "#" renders
// as a heading, "-" as a list item, "---" alone as a rule or, under another line, a setext
// underline that turns that line into a heading. The escaped values above never start a line,
// but the rule is kept so escapeMarkdown stands on its own if that changes. The first character
// is written as a reference, after any leading spaces, because a renderer allows up to three
// spaces of indent before block markup.
const BLOCK_MARKER_AT_LINE_START = /^(\s*)([#\-+*=]|\d(?=\d*[.)]))/;

// A renderer turns "https://example.test/path" and "www.example.test" into links without being
// asked. Both are matched on the raw bytes, the "://" of a scheme and the "www." of a bare host,
// so a reference in place of the colon or the dot stops the link and still renders as the same
// character. Only a colon followed by "//" is touched, so a label like "why:" stays readable.
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
//
// The value is rendered exactly, spaces included. CommonMark strips one space from each end of
// a span only when the content begins and ends with a space and is not all spaces, so a value
// that does both is padded by one space on each side and comes back whole; so is a value that
// begins or ends with a backtick, which the padding keeps off the fence. An empty value is
// written as a span holding one space, because two bare backticks are not a span at all.
function inlineCode(value: string): string {
  if (value.length === 0) {
    return '` `';
  }
  let longestRun = 0;
  let run = 0;
  for (const character of value) {
    run = character === '`' ? run + 1 : 0;
    longestRun = Math.max(longestRun, run);
  }
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && value.trim().length > 0);
  const padding = needsPadding ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

// One line inside a frame: an engine-authored label and a page-derived value.
interface FramedPiece {
  label: string;
  value: string;
}

// The framed block as Markdown lines: the opening marker, one line per piece, the closing marker.
//
// The two markers are engine text and the interface the overlay and the model match on, so they
// stay exactly as they are and sit outside the code spans, where they render as the visible seal.
// Each value is scrubbed here, the same scrub frameUntrustedBlock applies, so it cannot carry a
// marker and the only markers in the block are the two this function writes. A scrubbed value
// holds no line break, because the neutralizer folds separators to a space, so one piece is one
// line, and every line starts with its label. That matters twice: a line that starts with a
// label can never open a fenced code block, which a line starting with three backticks would,
// and no join of consecutive lines can produce the marker text.
function framedMarkdownLines(pieces: FramedPiece[]): string[] {
  return [
    UNTRUSTED_FRAME_START,
    ...pieces.map((piece) => `${piece.label}: ${inlineCode(scrubString(piece.value))}`),
    UNTRUSTED_FRAME_END,
  ];
}

const HEADLINE: Record<Verdict, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

function projectHeadline(verdict: Verdict): string {
  return `## usabl report: ${HEADLINE[verdict]}`;
}

// A Result with no verdict is one of two opposite facts, and the shared verdict line tells them
// apart. Idle is exit 0 with nothing to check: no UI file changed, so there is nothing to report
// and the comment says only that. A failed run is exit 4: usabl proved nothing, and the comment
// says so with the engine's reason, sealed, because a crash summary carries a raw error message.
// Neither prints the sections a real verdict fills, since "none" under every heading reads as a
// clean run, and neither prints a receipt line, since a receipt exists only for a verified run
// and "run was not verified" would read as a run that was checked and failed. A null verdict
// with any other exit code can only be composed outside run(); it reads as no verdict with the
// reason, and never as idle, the same way the Stop hook reads it.
function renderNoVerdict(result: Result): string[] {
  const line = describeVerdict(result);
  if (result.exitCode === 0 && result.coverage.nothingToCheck) {
    return [COMMENT_MARKER, `## usabl report: ${formatVerdictWord(line)}`, '', line.meaning];
  }
  const failed = result.exitCode === 4;
  const word = failed ? formatVerdictWord(line) : `NO VERDICT (exit ${result.exitCode})`;
  const meaning = failed ? line.meaning : 'usabl did not reach a verdict for this change.';
  return [
    COMMENT_MARKER,
    `## usabl report: ${word}`,
    '',
    meaning,
    '',
    ...framedMarkdownLines([{ label: 'engine summary', value: result.summary }]),
  ];
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

// The source location and candidates as pieces for the untrusted frame. An app finding's source
// file can be read from a renderer-injected DOM attribute, so it is page-influenced and belongs
// inside the frame with the rest of the dynamic finding text. The frame scrubs each value, so
// these are passed raw rather than pre-neutralized.
function sourcePieces(
  source: DocsSourceMapping | undefined,
  appSource: AppSourceMapping | undefined,
): FramedPiece[] {
  if (source !== undefined && source.file !== null) {
    const pieces = [{ label: 'source', value: formatDocsSourceLocation(source) }];
    if (source.candidates.length > 1) {
      pieces.push({ label: 'candidates', value: source.candidates.join(', ') });
    }
    return pieces;
  }
  if (appSource !== undefined && appSource.file !== null) {
    const pieces = [{ label: 'source', value: formatAppSourceLocation(appSource) }];
    if (appSource.candidates.length > 1) {
      pieces.push({ label: 'candidates', value: appSource.candidates.join(', ') });
    }
    return pieces;
  }
  if (appSource !== undefined && appSource.candidates.length > 0) {
    return [{ label: 'candidates', value: appSource.candidates.join(', ') }];
  }
  return [];
}

// One frame around every dynamic finding field, and every value in it in a code span. Where each
// value comes from decides that:
//
//   experience is page text. usabl builds it from the element's accessible name, or a scanner
//   describes the node, so it says whatever the page says.
//   why and fix are provider-authored for the built-in providers, but only five axe rules carry
//   a curated note; for every other rule both fall back to axe's failureSummary, whose check
//   messages quote attribute values from the page. So they are page-influenced and spanned.
//   source and candidates are path text. A docs mapping comes from the repository, but an app
//   mapping can be read from a renderer-injected DOM attribute, so a page can choose it. Spanned,
//   and a path reads well in a code span anyway.
//
// Only the engine-authored header (severity, screen id, layer, rule) stays outside the frame.
// That matches how the stop hook frames its block.
function findingPieces(finding: Finding): FramedPiece[] {
  return [
    { label: 'experience', value: finding.whatUserExperiences },
    { label: 'why', value: finding.why },
    ...sourcePieces(finding.docsSource, finding.appSource),
    { label: 'fix', value: fixOrAbsence(finding) },
  ];
}

// One list item: the marker and first line, then every continuation line indented by the
// marker's content offset.
//
// CommonMark makes a continuation line part of the item only when it is indented to where the
// item's content starts, which is the marker plus the space after it: two columns for "- ",
// three for "1. ", four for "10. ". A continuation indented less than that leaves the item and
// renders as a paragraph outside the list, and a marker with nothing after it renders as an empty
// item. So the first line always goes on the marker's line, and the indent is computed from the
// marker text rather than written as a constant, so a two-digit index stays correct.
function listItem(marker: string, first: string, continuation: string[]): string[] {
  const indent = ' '.repeat(marker.length + 1);
  return [`${marker} ${first}`, ...continuation.map((line) => `${indent}${line}`)];
}

function formatFinding(finding: Finding): string[] {
  const rule = neutralize(finding.rule);
  const layer = neutralize(finding.layer);
  const screenId = neutralize(finding.screenId);
  const severity = neutralize(finding.severity);
  return listItem(
    '-',
    `[${escapeMarkdown(severity)}] ${inlineCode(screenId)} - ${inlineCode(`${layer}/${rule}`)}`,
    framedMarkdownLines(findingPieces(finding)),
  );
}

function renderFindingGroup(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) {
    return [`### ${title}`, '- none'];
  }
  return [`### ${title}`, ...findings.flatMap((finding) => formatFinding(finding))];
}

// The headline is built from the group's fields rather than from one formatted string, so the
// screen id can be sealed on its own. It is the only part of this line the application chooses:
// the router fallback derives a screen id from a route literal, so an id can be written to read
// as a mention, an address, an issue reference, or a commit id, and a post-render filter would
// then turn it into a link or a notification. It gets the same code span the rule line gives it.
// Status and severity are usabl's own vocabulary and the count is a number this surface
// computed, so those stay as escaped prose.
function formatCollapsedFinding(group: CollapsedFindingGroup): string[] {
  const finding = group.representative;
  const rule = neutralize(finding.rule);
  const layer = neutralize(finding.layer);
  const screenId = neutralize(finding.screenId);
  const severity = neutralize(finding.severity);
  // The prose around the spans is escaped as a whole, brackets included, so this line renders
  // exactly as it did when the whole headline was one escaped string.
  const status = escapeMarkdown(`[${group.status} ${severity}]`);
  const count = escapeMarkdown(formatCollapsedGroupCount(group));
  const headline = `${status} ${inlineCode(screenId)}/${inlineCode(`${layer}/${rule}`)}${count}`;
  // The rule line is a continuation of the item, not a nested item. A nested item would make
  // the framed lines after it lazy continuations of the nested paragraph, so they would render
  // inside the wrong item.
  return listItem('-', headline, [
    `rule: ${inlineCode(screenId)} - ${inlineCode(`${layer}/${rule}`)} · ${escapeMarkdown(severity)}`,
    ...framedMarkdownLines(findingPieces(finding)),
  ]);
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
      // page- or tool-derived, so they are sealed as untrusted for the model reading this comment
      // and spanned so a URL in the ref cannot become a link the page chose. The state is an
      // engine enum and stays as the plain label.
      const framed = framedMarkdownLines([
        { label: 'ref', value: gap.ref },
        { label: 'reason', value: gap.reason },
      ]);
      // A state is an engine enum and no page can choose one, but `Result` is exported and a
      // caller can compose one outside the engine, so the label is any string at runtime. It
      // costs one code span to keep that out of the renderer's and the filters' reach.
      return listItem('-', `(${inlineCode(neutralize(gap.state))})`, framed);
    }),
  ];
}

// The announcement text for one stop, page-derived: tokens come from the accessibility tree and
// live regions, and the element-path fallback is a DOM selector. Returned raw; the caller frames
// it, and the frame scrubs it, so it is not pre-neutralized here.
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
      // The frame opens on the marker's line. A bare "1." renders as an empty item, and the
      // frame under it, indented two columns where "1. " needs three, would leave the list.
      const [first, ...rest] = framedMarkdownLines([
        { label: 'announced', value: stopAnnouncementText(stop) },
      ]);
      lines.push(...listItem(`${stop.index + 1}.`, first!, rest));
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
  if (safe.verdict === null) {
    return renderNoVerdict(safe).join('\n');
  }
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

  // Every section is printed for a real verdict, "none" included: under a real verdict an empty
  // section is a fact about the run, where under no verdict it would read as a clean one.
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
