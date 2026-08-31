import type { DocArtifact } from '../contracts/index.js';

// Renders the JSON artifacts from `usabl docs` into one self-contained, accessible
// HTML page. This surface renders; it never decides. The gate is the only verdict
// authority, so the page carries the same honesty invariant the engine does: an
// artifact is shown as proof only when it is bound to a minted receipt. Everything
// else is labelled, in words, as an observation and never as a verdict.
//
// The function is pure and deterministic: same artifacts in, same string out. It
// performs no I/O and reads no clock, so the CLI owns when and where the page is
// written.

/**
 * Escapes the five HTML-significant characters so that page-derived text can
 * never break out of its text node or an attribute. The generator already
 * neutralises control bytes before an artifact is minted; this is the second,
 * output-side layer that makes the rendered document safe on its own.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; " +
  "form-action 'none'; upgrade-insecure-requests";

// Human-facing names for each artifact kind. Fixed strings, never page-derived.
const KIND_LABEL: Record<DocArtifact['kind'], string> = {
  'announcement-snippets': 'Screen reader announcements',
  'keyboard-paths': 'Keyboard walk order',
  'alt-text-manifest': 'Alt text manifest',
};

// The first two data columns per kind. The status column is always present; the
// evidence column is added only when the artifact's entries actually cite one.
const KIND_COLUMNS: Record<DocArtifact['kind'], [string, string]> = {
  'announcement-snippets': ['Element', 'Announcement'],
  'keyboard-paths': ['Focus step', 'Announcement'],
  'alt-text-manifest': ['Selector', 'Expected text'],
};

// The three honesty states an artifact can be in. The gate is the only verdict
// authority, so these describe how much proof an artifact carries, never a verdict
// the page invents.
type Proof = 'verified' | 'bound-no-evidence' | 'observation';

/** Whether this artifact is bound to a minted receipt for its surface. */
function isBound(artifact: DocArtifact): boolean {
  return typeof artifact.boundToReceipt === 'string' && artifact.boundToReceipt.length > 0;
}

/**
 * Classifies an artifact's honesty state. Surface-level binding and per-entry
 * evidence are two separate truth signals, and they are not the same thing: the
 * alt-text manifest binds to a receipt but mints no per-entry evidence, so it must
 * never read as verified. An artifact is verified only when it is bound AND its
 * entries cite evidence; bound without evidence is an expectation, not proof; and
 * no binding at all is an observation.
 */
function classify(artifact: DocArtifact, hasEvidence: boolean): Proof {
  if (!isBound(artifact)) return 'observation';
  return hasEvidence ? 'verified' : 'bound-no-evidence';
}

/**
 * The honesty banner for one artifact. Each state carries a leading glyph and a
 * distinct text label, so the distinction is never conveyed by colour alone.
 * A verified card cites its receipt and mint time as proof; a bound-without-
 * evidence card shows the receipt but says, in words, that its entries are not
 * per-element proof; an observation makes no receipt claim at all.
 */
function renderStatus(artifact: DocArtifact, hasEvidence: boolean): string {
  const state = classify(artifact, hasEvidence);
  const hash = escapeHtml(artifact.boundToReceipt ?? '');
  const generated = escapeHtml(artifact.generatedAt);
  const when = generated
    ? `, generated <time datetime="${generated}">${generated}</time>`
    : '';

  if (state === 'verified') {
    return (
      `<p class="status status--bound">` +
      `<span class="status__mark" aria-hidden="true">✔</span> ` +
      `<span class="status__label">Verified.</span> ` +
      `Bound to receipt <code>${hash}</code>${when}.` +
      `</p>`
    );
  }
  if (state === 'bound-no-evidence') {
    return (
      `<p class="status status--intake">` +
      `<span class="status__mark" aria-hidden="true">◆</span> ` +
      `<span class="status__label">Not proof.</span> ` +
      `Bound to receipt <code>${hash}</code>${when}, but no per-entry evidence was ` +
      `minted, so these entries are expectations, not per-element proof.` +
      `</p>`
    );
  }
  return (
    `<p class="status status--observation">` +
    `<span class="status__mark" aria-hidden="true">⚠</span> ` +
    `<span class="status__label">Not verified.</span> ` +
    `These are observations, not proof. No receipt was minted for this run, so ` +
    `nothing on this card is bound to gate coverage.` +
    `</p>`
  );
}

/** One artifact rendered as a captioned, scoped table (or an empty note). */
function renderArtifact(artifact: DocArtifact): string {
  const label = KIND_LABEL[artifact.kind];
  const [firstCol, secondCol] = KIND_COLUMNS[artifact.kind];
  const hasEvidence = artifact.entries.some((entry) => Boolean(entry.evidenceRef));

  // The h3 gives this block structure; it is not a named landmark, so it does not
  // add a redundant region to the assistive-technology landmark list.
  const parts: string[] = [];
  parts.push('<section class="artifact">');
  parts.push(`<h3 class="artifact__title">${escapeHtml(label)}</h3>`);
  parts.push(renderStatus(artifact, hasEvidence));

  if (artifact.entries.length === 0) {
    parts.push(`<p class="artifact__empty">No entries were generated for this surface.</p>`);
    parts.push('</section>');
    return parts.join('');
  }

  const headers = [firstCol, secondCol, 'Status'];
  if (hasEvidence) headers.push('Evidence');

  const headRow = headers
    .map((header) => `<th scope="col">${escapeHtml(header)}</th>`)
    .join('');

  const bodyRows = artifact.entries
    .map((entry) => {
      const cells = [
        `<td><code>${escapeHtml(entry.element)}</code></td>`,
        `<td>${escapeHtml(entry.content)}</td>`,
        `<td>${escapeHtml(entry.status)}</td>`,
      ];
      if (hasEvidence) {
        cells.push(
          entry.evidenceRef
            ? `<td><code>${escapeHtml(entry.evidenceRef)}</code></td>`
            : '<td class="cell--none">not bound</td>',
        );
      }
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  parts.push('<table>');
  parts.push(`<caption>${escapeHtml(label)}</caption>`);
  parts.push(`<thead><tr>${headRow}</tr></thead>`);
  parts.push(`<tbody>${bodyRows}</tbody>`);
  parts.push('</table>');
  parts.push('</section>');
  return parts.join('');
}

/** Groups artifacts by surface, preserving the order each surface first appears. */
function groupBySurface(artifacts: DocArtifact[]): Array<[string, DocArtifact[]]> {
  const order: string[] = [];
  const groups = new Map<string, DocArtifact[]>();
  for (const artifact of artifacts) {
    const existing = groups.get(artifact.surface);
    if (existing) {
      existing.push(artifact);
    } else {
      order.push(artifact.surface);
      groups.set(artifact.surface, [artifact]);
    }
  }
  return order.map((surface) => [surface, groups.get(surface) ?? []]);
}

const STYLE = `
    :root {
      color-scheme: light;
      --ink: #101827;
      --paper: #f7f5ef;
      --white: #fff;
      --blue: #2457e6;
      --green: #177a4a;
      --amber: #a95f00;
      --slate: #596579;
      --line: #cbd1da;
      --soft: #e9edf4;
      --sans: Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.58 var(--sans); }
    code { font-family: var(--mono); font-size: .9em; overflow-wrap: anywhere; }
    .skip {
      position: fixed; z-index: 100; top: .75rem; left: .75rem;
      padding: .7rem 1rem; background: var(--white); transform: translateY(-180%);
    }
    .skip:focus { transform: translateY(0); }
    .masthead { background: var(--ink); color: var(--white); border-bottom: 3px solid var(--blue); }
    .masthead-inner, main { width: min(calc(100% - 3rem), 1100px); margin: auto; }
    .masthead-inner { padding: 1.6rem 0; }
    .masthead h1 { margin: 0; font-size: 1.5rem; letter-spacing: -.02em; }
    .masthead p { margin: .35rem 0 0; color: #cfd8eb; font-size: .95rem; }
    main { padding: 2.5rem 0 4rem; }
    .overview { background: var(--white); border: 1px solid var(--line); border-radius: 10px; padding: 1.2rem 1.4rem; margin-bottom: 2.5rem; }
    .overview h2 { margin-top: 0; }
    .surface { margin: 0 0 3rem; }
    .surface > h2 { border-bottom: 2px solid var(--line); padding-bottom: .4rem; }
    .artifact { margin: 1.6rem 0; }
    .artifact__title { margin: 0 0 .5rem; font-size: 1.1rem; }
    .status { margin: .3rem 0 .9rem; padding: .6rem .85rem; border-radius: 8px; border-left: 6px solid var(--line); background: var(--soft); }
    .status__mark { font-weight: 700; }
    .status__label { font-weight: 750; }
    .status--bound { border-left-color: var(--green); }
    .status--intake { border-left-color: var(--slate); }
    .status--observation { border-left-style: dashed; border-left-color: var(--amber); border-left-width: 6px; }
    table { border-collapse: collapse; width: 100%; background: var(--white); border: 1px solid var(--line); }
    caption { text-align: left; font-weight: 700; padding: .5rem .2rem; }
    th, td { text-align: left; vertical-align: top; padding: .5rem .7rem; border-bottom: 1px solid var(--line); }
    thead th { background: var(--soft); }
    .cell--none { color: var(--amber); font-style: italic; }
    .page-footer { width: min(calc(100% - 3rem), 1100px); margin: 2rem auto 3rem; color: #445; font-size: .9rem; border-top: 1px solid var(--line); padding-top: 1rem; }
    @media print { body { background: var(--white); } .skip { display: none; } table { border: 1px solid #000; } }
`;

function documentShell(title: string, bodyMain: string): string {
  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `  <meta http-equiv="Content-Security-Policy" content="${CSP}">\n` +
    '  <meta name="referrer" content="no-referrer">\n' +
    '  <meta name="robots" content="noindex, nofollow, noarchive">\n' +
    '  <meta name="description" content="Accessibility documentation generated by usabl docs. The gate is the only verdict authority.">\n' +
    `  <title>${escapeHtml(title)}</title>\n` +
    `  <style>${STYLE}</style>\n` +
    '</head>\n' +
    '<body>\n' +
    '  <a class="skip" href="#main-content">Skip to main content</a>\n' +
    '  <header class="masthead"><div class="masthead-inner">\n' +
    `    <h1>${escapeHtml(title)}</h1>\n` +
    '    <p>Generated by <code>usabl docs</code>. usabl reports; the gate decides. A card is proof only when it is verified against a minted receipt.</p>\n' +
    '  </div></header>\n' +
    // tabindex="-1" makes the main landmark a reliable focus target, so a skip-link
    // activation moves focus into the content instead of resuming from the link.
    `  <main id="main-content" tabindex="-1">\n${bodyMain}\n  </main>\n` +
    '  <footer class="page-footer">\n' +
    '    <p>This page is a generated artifact, not a verdict. A card is proof only when it is <strong>Verified</strong>: bound to a minted receipt with per-entry evidence. A card marked <strong>Not proof</strong> shows a receipt but has no per-entry evidence, so its entries are expectations. A card marked <strong>Not verified</strong> is an observation of what the interface announced, with no receipt at all.</p>\n' +
    '  </footer>\n' +
    '</body>\n' +
    '</html>\n'
  );
}

const TITLE = 'usabl accessibility documentation';

/**
 * Renders the artifacts from a `usabl docs` run into one accessible HTML page.
 * Passing an empty array yields an honest empty-state page that makes no
 * verified claim.
 */
export function renderDocsHtml(artifacts: DocArtifact[]): string {
  if (artifacts.length === 0) {
    const body =
      '    <section class="overview">\n' +
      '      <h2>Nothing to document</h2>\n' +
      '      <p>No accessibility documentation was generated for this run. That is the ' +
      'expected result when the working tree is clean or no surfaces were in scope: ' +
      'usabl documents what a run actually reached, and refuses to invent the rest.</p>\n' +
      '    </section>';
    return documentShell(TITLE, body);
  }

  const groups = groupBySurface(artifacts);

  // Count each honesty state separately so the overview matches what the cards
  // below actually claim. Binding and per-entry evidence are two distinct signals,
  // so a bound-without-evidence artifact is counted apart from a verified one.
  let verifiedCount = 0;
  let intakeCount = 0;
  let observationCount = 0;
  for (const artifact of artifacts) {
    const hasEvidence = artifact.entries.some((entry) => Boolean(entry.evidenceRef));
    const state = classify(artifact, hasEvidence);
    if (state === 'verified') verifiedCount += 1;
    else if (state === 'bound-no-evidence') intakeCount += 1;
    else observationCount += 1;
  }

  const overview =
    '    <section class="overview">\n' +
    '      <h2>What this page contains</h2>\n' +
    `      <p>${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} across ` +
    `${groups.length} surface${groups.length === 1 ? '' : 's'}. ` +
    `${verifiedCount} bound to a minted receipt and shown as verified; ` +
    (intakeCount > 0
      ? `${intakeCount} bound to a receipt without per-entry evidence, shown as expectations; `
      : '') +
    `${observationCount} shown as observations only, with no receipt claim.</p>\n` +
    '    </section>';

  // Each surface section is named by its own heading via aria-labelledby, so the
  // landmark carries the visible title rather than a second, duplicated label.
  const sections = groups
    .map(([surface, group], index) => {
      const headingId = `surface-${index}`;
      const cards = group.map(renderArtifact).join('\n');
      return (
        `    <section class="surface" aria-labelledby="${headingId}">\n` +
        `      <h2 id="${headingId}">Surface: ${escapeHtml(surface)}</h2>\n` +
        `${cards}\n` +
        '    </section>'
      );
    })
    .join('\n');

  return documentShell(TITLE, `${overview}\n${sections}`);
}
