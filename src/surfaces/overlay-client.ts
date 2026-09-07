/**
 * Browser client source for the advisory accessibility inspector.
 * This unit renders read-only status from server projections.
 * It must never influence gate outcomes or trust page text as HTML.
 */
import { UNTRUSTED_FRAME_END, UNTRUSTED_FRAME_START } from './scrub.js';

export const overlayClientSource = `(() => {
  const RESULT_ENDPOINT = '/__usabl/result';
  const HOST_ATTRIBUTE = 'data-usabl-inspector';
  const HIGHLIGHT_ATTRIBUTE = 'data-usabl-highlight';
  const OPEN_STORAGE_KEY = 'usabl.overlay.open';
  const WIDE_STORAGE_KEY = 'usabl.overlay.wide';
  const DOCK_STORAGE_KEY = 'usabl.overlay.dock';
  const COMPACT_WIDTH = 'min(420px, calc(100vw - 24px))';
  const WIDE_WIDTH = 'min(640px, calc(100vw - 24px))';
  // The four corners the panel can dock to. The panel is fixed, so a finding in the panel's own
  // corner sits behind it. Docking lets the user move it, and auto-dodge moves it for them when they
  // ask to see an element the panel is covering. The offset from each edge matches the original
  // bottom-right placement so the panel keeps the same inset wherever it docks.
  const DOCK_INSET_PX = 12;
  const DOCK_INSET = DOCK_INSET_PX + 'px';
  const DOCK_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const DEFAULT_DOCK = 'bottom-right';
  const DOCK_LABELS = {
    'top-left': 'top left',
    'top-right': 'top right',
    'bottom-left': 'bottom left',
    'bottom-right': 'bottom right',
  };
  // Interpolated from the one definition in scrub.ts. This client unwraps a framed value by
  // matching these exact strings, so a second copy here would stop unwrapping the moment the
  // marker wording changed, and would show a user raw markers instead of the page text.
  const UNTRUSTED_START = ${JSON.stringify(UNTRUSTED_FRAME_START)};
  const UNTRUSTED_END = ${JSON.stringify(UNTRUSTED_FRAME_END)};

  // Captured at module load, before any page script has had a chance to replace them. The overlay
  // runs in the page's own realm, so it can never be made tamper proof, but the cheapest lever is a
  // page swapping window.fetch and feeding the inspector a result the engine never produced. Taking
  // our own references removes that lever. This is hardening, not a security boundary: the gate,
  // not the overlay, decides anything that matters.
  const nativeToString = Function.prototype.toString;
  const nativeFetch = window.fetch.bind(window);
  const nativeResponseJson = Response.prototype.json;
  const nativeConsoleError = console.error.bind(console);

  // Capturing only wins the race against a script that runs AFTER us. A script that runs BEFORE us
  // has already replaced the global, and there is no honest way to recover the real one from inside
  // the page's own realm. So we also check whether what we captured is the browser's own
  // implementation. When it is not, the overlay says so on its own surface rather than presenting a
  // result it cannot vouch for. Telling the developer we might be lying is worth more than a
  // guarantee we cannot keep.
  function looksNative(fn) {
    try {
      return nativeToString.call(fn).indexOf('[native code]') >= 0;
    } catch (_error) {
      return false;
    }
  }

  const globalsReplaced = !looksNative(window.fetch) || !looksNative(Response.prototype.json);

  // A page cannot suppress the overlay by pre-creating an element with a known id, because the
  // overlay never looks its own host up by id. It keeps the reference it created. The random suffix
  // only keeps the id from colliding with the host page's own ids.
  const INSTANCE_SUFFIX = Math.random().toString(36).slice(2, 10);
  const HOST_ID = '__usabl-overlay-' + INSTANCE_SUFFIX;
  const PANEL_ID = '__usabl-inspector-panel-' + INSTANCE_SUFFIX;
  const TITLE_ID = '__usabl-inspector-title-' + INSTANCE_SUFFIX;
  const HIGHLIGHT_ID = '__usabl-highlight-' + INSTANCE_SUFFIX;

  // Severity decides the order of the list and the word on every row. The word is what carries the
  // meaning; the coloured dot beside it is decoration and is hidden from assistive technology.
  const SEVERITY_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const SEVERITY_WORD = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };
  const UNRATED_RANK = 4;

  const MISSING_ELEMENT_TEXT =
    'This was flagged here at the last scan; it is not on the page right now.';

  // Bounds on the work one render is allowed to do. A Result is engine-authored but its finding text
  // is page-derived, so a hostile or simply enormous page can hand us megabyte strings and thousands
  // of findings. None of these bounds change what is REPORTED: the counts and the total always come
  // from the full list. They only bound what is built into the DOM at one time.
  const ROW_PAGE_SIZE = 40;
  const MAX_TITLE_CHARS = 2000;
  const MAX_PROSE_CHARS = 2000;
  const MAX_SELECTOR_CHARS = 400;
  const SHORTENED_NOTE = ' [shortened for display]';

  const state = {
    // The host element we created. Held, never looked up, so nothing on the page can impersonate it.
    host: null,
    open: false,
    wide: false,
    // Which corner the panel is docked to. Persisted like the wide setting.
    dock: DEFAULT_DOCK,
    payload: null,
    error: false,
    scanning: false,
    split: null,
    // Exactly one row may be expanded, and the highlight on the page belongs to that row. Both are
    // held here so the two can never drift apart.
    expandedKey: null,
    highlightKey: null,
    highlightCleanup: null,
    // The exact marker node and the exact element we borrowed a tabindex from, with its original
    // value. Cleanup restores these references and never queries the document for things to undo,
    // because a document-wide query undoes elements the overlay does not own.
    marker: null,
    borrowedTabindex: null,
    rows: [],
    renderedRowCount: 0,
    liveStatus: null,
    verdictStatus: null,
    lastVerdictAnnouncement: '',
    navHooked: false,
  };

  // Persisted preferences are a convenience. A browser with storage disabled, a private window that
  // throws on write, or a sandboxed frame with no localStorage at all must still get a working
  // overlay, so every read falls back to the default and every write is allowed to fail.
  function storedValue(key) {
    try {
      const store = window.localStorage;
      if (!store) {
        return null;
      }
      return store.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function storeValue(key, value) {
    try {
      const store = window.localStorage;
      if (!store) {
        return;
      }
      store.setItem(key, value);
    } catch (_error) {
      // Ignored on purpose. Losing a preference is acceptable; losing the overlay is not.
    }
  }

  function displayText(value) {
    if (typeof value !== 'string') {
      return '';
    }
    if (value.startsWith(UNTRUSTED_START) && value.endsWith(UNTRUSTED_END)) {
      return value.slice(UNTRUSTED_START.length, -UNTRUSTED_END.length).trim();
    }
    return value;
  }

  // Unwrap the frame, then bound the length. A single 10MB title used to take most of a second to
  // lay out and could be used to stall the panel. Cutting it is honest as long as we say we cut it,
  // and the full text is still in the Result that usabl check prints.
  function boundedText(value, limit) {
    const text = displayText(value);
    if (text.length <= limit) {
      return text;
    }
    return text.slice(0, limit) + SHORTENED_NOTE;
  }

  // Object.hasOwn, not a bare index, so an unexpected severity string can never read an inherited
  // prototype member and turn into a function where a number or a word is expected.
  function severityRank(value) {
    return Object.hasOwn(SEVERITY_RANK, value) ? SEVERITY_RANK[value] : UNRATED_RANK;
  }

  function severityWord(value) {
    return Object.hasOwn(SEVERITY_WORD, value) ? SEVERITY_WORD[value] : 'Unrated';
  }

  function severityKey(value) {
    return Object.hasOwn(SEVERITY_RANK, value) ? value : 'unrated';
  }

  function countLabel(count, noun) {
    return count + ' ' + (count === 1 ? noun : noun + 's');
  }

  // Compare a scan-time url to the live pathname on PATHNAME only.
  //
  // The scan runs against one host (for example 127.0.0.1:5173) and the developer may open the app
  // on a different host or port. Host and port would never match across those two, so matching there
  // would always fail and the overlay would look empty on every screen. The path is the stable
  // identity of a screen, so we normalize both to a pathname with any trailing slash removed and
  // compare only that. A malformed scan-time url is treated as no match rather than throwing.
  function pathnameOf(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      return null;
    }
    let path;
    try {
      // A base lets us parse an absolute url or a bare path with the same call.
      path = new URL(rawUrl, 'http://usabl.invalid').pathname;
    } catch (_error) {
      return null;
    }
    return normalizePath(path);
  }

  function normalizePath(path) {
    if (typeof path !== 'string' || path === '') {
      return '/';
    }
    // Treat "/clusters" and "/clusters/" as the same screen. Keep "/" as "/".
    if (path.length > 1 && path.endsWith('/')) {
      return path.slice(0, -1);
    }
    return path;
  }

  // The whole location after the host: normalized pathname, then query, then hash. This is the key
  // a coverage gap is matched on. A gap names one exact page, and "/report?view=b" is not the page
  // "/report?view=a", nor is "/#/jobs" the page "/#/clusters" under a hash router. Comparing on the
  // pathname alone collapsed all of those onto one screen and attributed the wrong gap to it. Host
  // and port are still ignored, for the same reason pathnameOf ignores them.
  function locationKeyOf(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      return null;
    }
    let url;
    try {
      url = new URL(rawUrl, 'http://usabl.invalid');
    } catch (_error) {
      return null;
    }
    return normalizePath(url.pathname) + url.search + url.hash;
  }

  function liveLocationKey() {
    return normalizePath(window.location.pathname) + window.location.search + window.location.hash;
  }

  // Split findings into the screen the browser is on and every other scanned screen.
  //
  // The overlay is screen-aware: it guides the developer one screen at a time. It matches the live
  // pathname to a scanned screen through coverage.affected, then partitions findings by screenId.
  // "here" is a flat list of this screen's findings sorted worst first, each individually locatable.
  // "elsewhere" is a per-screen count plus a path to navigate to, and never the other screens'
  // individual findings.
  function partitionByScreen(payload, currentPath, currentLocation) {
    const affected = (payload && payload.coverage && Array.isArray(payload.coverage.affected))
      ? payload.coverage.affected
      : [];
    const findings = (payload && Array.isArray(payload.findings)) ? payload.findings : [];
    const normalizedCurrent = normalizePath(currentPath);

    // Map each affected screenId to its normalized pathname, and find which one is current. The
    // exact scan-time locations are kept too, so a gap that names another screen's page can be told
    // apart from a gap that names no screen at all.
    let currentScreenId = null;
    const screenPath = new Map();
    const screenIds = new Set();
    const screenLocations = new Set();
    for (const screen of affected) {
      screenIds.add(screen.screenId);
      const location = locationKeyOf(screen.url);
      if (location !== null) {
        screenLocations.add(location);
      }
      const path = pathnameOf(screen.url);
      if (path === null) {
        continue;
      }
      if (!screenPath.has(screen.screenId)) {
        screenPath.set(screen.screenId, path);
      }
      if (currentScreenId === null && path === normalizedCurrent) {
        currentScreenId = screen.screenId;
      }
    }

    const here = [];
    const elsewhereCounts = new Map();
    for (const finding of findings) {
      if (currentScreenId !== null && finding.screenId === currentScreenId) {
        here.push(finding);
        continue;
      }
      const entry = elsewhereCounts.get(finding.screenId)
        || { screenId: finding.screenId, count: 0, worstRank: UNRATED_RANK, worstSeverity: 'unrated' };
      entry.count += 1;
      const rank = severityRank(finding.severity);
      if (rank < entry.worstRank) {
        entry.worstRank = rank;
        entry.worstSeverity = severityKey(finding.severity);
      }
      elsewhereCounts.set(finding.screenId, entry);
    }

    // Worst first, so the row a developer should read first is the row they see first. Array sort is
    // stable, so findings of equal severity keep the order the engine gave them.
    here.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    const elsewhere = [];
    let elsewhereTotal = 0;
    for (const entry of elsewhereCounts.values()) {
      // Prefer the scan-time pathname for this screen when we have one, so the navigating link is a
      // real route. When a finding names a screen that is not in coverage.affected, we have no path
      // and omit the link rather than guess a route that may not exist.
      const path = screenPath.get(entry.screenId) || null;
      elsewhereTotal += entry.count;
      elsewhere.push({
        screenId: entry.screenId,
        count: entry.count,
        worstRank: entry.worstRank,
        worstSeverity: entry.worstSeverity,
        path,
      });
    }
    elsewhere.sort(
      (a, b) => a.worstRank - b.worstRank || b.count - a.count || a.screenId.localeCompare(b.screenId),
    );

    const gaps = gapsForScreen(payload, currentScreenId, currentLocation, screenIds, screenLocations);

    return {
      matched: currentScreenId !== null,
      currentScreenId,
      currentPath: normalizedCurrent,
      here,
      elsewhere,
      elsewhereTotal,
      gap: gaps.here,
      unattributedGaps: gaps.unattributed,
    };
  }

  // The coverage gap that concerns the screen the browser is on, and the number of gaps that this
  // panel could not attribute to any screen.
  //
  // A screen can be in coverage.affected and still have no scan result: the browser was unavailable,
  // the route refused to load, a capability was denied. Listing "no findings" for that screen would
  // read as clean when nothing was checked. A gap names its subject as a surface id, a url, or a file
  // path, and the payload does not say which. So the match is exact or it is no match at all: a
  // url-shaped ref must equal the whole live location (path, query, and hash), and a bare ref must
  // equal the current screen id. A bare ref is never read as a route, a path segment is never read
  // as an id, and a query or hash is never dropped, because each of those would attribute a gap to
  // a page it does not name. A gap that matches neither this screen nor any other affected screen
  // is counted, so the panel can say that it does not know where the gap belongs.
  function gapsForScreen(payload, currentScreenId, currentLocation, screenIds, screenLocations) {
    const gaps = (payload && payload.coverage && Array.isArray(payload.coverage.gaps))
      ? payload.coverage.gaps
      : [];
    let here = null;
    let unattributed = 0;
    for (const gap of gaps) {
      if (!gap || typeof gap.ref !== 'string') {
        continue;
      }
      const urlShaped = /^(https?:\\/\\/|\\/)/.test(gap.ref);
      const location = urlShaped ? locationKeyOf(gap.ref) : null;
      if (urlShaped) {
        if (location !== null && location === currentLocation) {
          if (here === null) here = gap;
        } else if (location === null || !screenLocations.has(location)) {
          unattributed += 1;
        }
        continue;
      }
      if (currentScreenId !== null && gap.ref === currentScreenId) {
        if (here === null) here = gap;
      } else if (!screenIds.has(gap.ref)) {
        unattributed += 1;
      }
    }
    return { here, unattributed };
  }

  // A pathname is not automatically a safe href. "//evil.example/x" is a valid pathname and also a
  // network-path reference, so assigning it to href sends the developer off site with one click.
  // A backslash form resolves the same way in browsers. So we reject the network-path shape outright
  // and then resolve against the current document and require the origin to still be ours.
  function sameOriginHref(path) {
    if (typeof path !== 'string' || path === '' || path.charAt(0) !== '/') {
      return null;
    }
    const second = path.charAt(1);
    if (second === '/' || second === '\\\\') {
      return null;
    }
    let resolved;
    try {
      resolved = new URL(path, window.location.href);
    } catch (_error) {
      return null;
    }
    if (resolved.origin !== window.location.origin) {
      return null;
    }
    return resolved.pathname + resolved.search;
  }

  function emptySplit(currentPath) {
    return {
      matched: false,
      currentScreenId: null,
      currentPath: normalizePath(currentPath),
      here: [],
      elsewhere: [],
      elsewhereTotal: 0,
      gap: null,
      unattributedGaps: 0,
    };
  }

  // A stable identity for a row across re-renders. Two findings that share every part of this key
  // are told apart by an occurrence suffix, so no two rows ever collide and a surviving row keeps
  // its key when a different finding is fixed and disappears.
  function rowKeyFor(finding) {
    return JSON.stringify([
      displayText(finding.elementKey) || '',
      String(finding.rule || ''),
      displayText(finding.elementPath) || '',
      String(finding.severity || ''),
    ]);
  }

  function keyedFindings(findings) {
    const seen = new Map();
    const rows = [];
    for (const finding of findings) {
      const base = rowKeyFor(finding);
      const seenCount = seen.get(base) || 0;
      seen.set(base, seenCount + 1);
      rows.push({ finding, key: seenCount === 0 ? base : base + '#' + seenCount });
    }
    return rows;
  }

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = displayText(text);
    }
    return element;
  }

  // The verdict word is the meaning. The symbol repeats it for scanning speed and the colour is
  // third, so nothing here depends on a reader telling red from green.
  //
  // A null verdict is the dangerous case. It is produced both by a run that had nothing to check and
  // by a run that crashed, was killed, or exited non-zero without minting a verdict. Reading every
  // null as "nothing to check" turned a crash into a calm grey pass. Idle is now the narrow case:
  // the run must have finished with exit code 0 AND said outright that there was nothing to check.
  // Everything else is an absence of proof and is named as one.
  function verdictFor(payload, error, scanning) {
    if (scanning) return { key: 'scanning', word: 'Scanning', symbol: '…' };
    if (error) return { key: 'error', word: 'Not verified', symbol: '!' };
    if (!payload || !payload.loaded) return { key: 'pending', word: 'No result yet', symbol: '○' };
    const verdict = payload.verdict;
    if (verdict === 'verified') return { key: 'verified', word: 'Verified', symbol: '✓' };
    if (verdict === 'regression') return { key: 'regression', word: 'Regression', symbol: '✕' };
    if (verdict === 'not_covered') return { key: 'not-covered', word: 'Not covered', symbol: '?' };
    if (verdict === 'approval_required') return { key: 'approval', word: 'Approval required', symbol: '!' };
    // Idle is the narrow case. The run must have produced a verdict that is exactly null, exited 0,
    // and said outright that there was nothing to check. The check is strict null on purpose: an
    // unknown verdict string, or a missing verdict field that reads as undefined, must fall through
    // to no-verdict rather than borrow the calm "Nothing to check" from its coverage fields. That
    // calm-grey-for-an-unknown-state read is the false green this product exists to stop.
    if (
      verdict === null &&
      payload.exitCode === 0 &&
      payload.coverage &&
      payload.coverage.nothingToCheck === true
    ) {
      return { key: 'idle', word: 'Nothing to check', symbol: '○' };
    }
    return { key: 'no-verdict', word: 'No verdict', symbol: '!' };
  }

  // Only these two states mean the run is not holding anything against you. Every other state must
  // keep the badge out of its clear appearance no matter how clean the current screen looks.
  function isSettledClean(verdictKey) {
    return verdictKey === 'verified' || verdictKey === 'idle';
  }

  // Why the screen in front of the developer has no result, when it is not the screen's fault.
  //
  // Two different things used to share one sentence, "this screen was not part of the last scan",
  // and a developer could not tell whether usabl skipped the screen on purpose or failed to check it.
  // Not affected: the changed files map to other screens, so usabl did not check this one by design.
  // The developer should go to the screens that were checked. That is a different decision from a
  // gap, which is handled by gapLine below.
  function unaffectedLine(payload, split) {
    const unresolved = payload && payload.coverage && Array.isArray(payload.coverage.unresolvedFiles)
      ? payload.coverage.unresolvedFiles.length
      : 0;
    // With unresolved files usabl cannot say the change did not touch this screen, only that it
    // could not map the change to it.
    const base = unresolved > 0
      ? 'usabl could not map your change to this screen, so it did not check it. '
        + countLabel(unresolved, 'changed file') + ' could not be mapped to any screen.'
      : 'Your change did not touch this screen, so usabl did not check it.';
    if (split.elsewhereTotal > 0) {
      return base + ' ' + countLabel(split.elsewhereTotal, 'issue')
        + (split.elsewhereTotal === 1 ? ' is' : ' are') + ' on '
        + countLabel(split.elsewhere.length, 'other screen') + '.';
    }
    return base + ' The run found no issues on the screens it checked.';
  }

  // The same fact, worded for the empty issues list under the header.
  function unaffectedBodyLine(payload) {
    const unresolved = payload && payload.coverage && Array.isArray(payload.coverage.unresolvedFiles)
      ? payload.coverage.unresolvedFiles.length
      : 0;
    return unresolved > 0
      ? 'usabl did not check this screen, because it could not map your change to it. There is nothing to list.'
      : 'usabl did not check this screen, because your change did not touch it. There is nothing to list.';
  }

  // The screen was in scope but usabl could not check it. The gap's reason is engine-authored and is
  // the fact the developer needs, so it is quoted here as well as in the coverage table below.
  function gapReason(gap) {
    const reason = boundedText(gap && gap.reason, MAX_PROSE_CHARS).trim().replace(/[.]+$/, '');
    return reason || 'no reason was given';
  }

  function gapLine(gap) {
    return 'usabl could not check this screen: ' + gapReason(gap)
      + '. Nothing here is proven. See the coverage gaps below.';
  }

  // The approval state, as facts a developer can act on, one per line.
  //
  // A guarded file changing and an accessibility barrier can happen in the same run. The approval is
  // out of the developer's hands; the barrier is what they can fix now. So the two are stated apart.
  // The accessibility verdict is the gate's, copied into the projection. It is repeated here, never
  // derived from the findings list.
  function approvalLines(payload, split) {
    const paths = Array.isArray(payload.dirtyGuardedPaths)
      ? payload.dirtyGuardedPaths.map((path) => boundedText(path, MAX_SELECTOR_CHARS)).filter(Boolean)
      : [];
    const lines = [];
    if (paths.length === 0) {
      lines.push('A guarded file changed, but the result did not name it.');
    } else {
      lines.push((paths.length === 1 ? 'Guarded file changed: ' : 'Guarded files changed: ')
        + paths.join(', ') + '.');
    }
    lines.push(
      'A code owner other than the author approves it on the pull request. '
        + 'Nothing in this panel or on your machine can approve it.',
    );
    lines.push(accessibilityLine(payload, split));
    lines.push(
      'If the change was unintended, revert the ' + (paths.length > 1 ? 'files' : 'file')
        + ' and this state clears.',
    );
    return lines;
  }

  // The accessibility verdict is never approval_required, so these three words cover every minted
  // value. A null verdict with exit 0 is a run with nothing to check; null with any other code is a
  // run that minted no verdict.
  const ACCESSIBILITY_WORD = { verified: 'VERIFIED', regression: 'REGRESSION', not_covered: 'NOT COVERED' };

  function accessibilityLine(payload, split) {
    // Where the issues are, for the developer who can fix them now. Empty when there are none.
    let where = '';
    if (split.matched && (split.here.length > 0 || split.elsewhereTotal > 0)) {
      where = countLabel(split.here.length, 'issue') + ' on this screen and '
        + split.elsewhereTotal + ' on other screens';
    } else if (split.elsewhereTotal > 0) {
      where = countLabel(split.elsewhereTotal, 'issue') + ' on '
        + countLabel(split.elsewhere.length, 'other screen');
    }

    // Absent, not null: an older projection that never carried the field. Say so and point at the
    // command that prints the gate's own verdict, rather than infer one from the list.
    if (!Object.hasOwn(payload, 'accessibilityVerdict')) {
      return 'Accessibility is judged separately from the approval.'
        + (where ? ' This run found ' + where + '.' : '')
        + ' This panel did not receive the accessibility verdict. Run usabl check to see it.';
    }

    const verdict = payload.accessibilityVerdict;
    const exit = payload.accessibilityExitCode;
    const exitNote = typeof exit === 'number' ? ' (exit ' + exit + ')' : '';
    let word;
    if (verdict === null) {
      word = exit === 0 ? 'nothing to check' : 'no verdict';
    } else if (Object.hasOwn(ACCESSIBILITY_WORD, verdict)) {
      word = ACCESSIBILITY_WORD[verdict];
    } else {
      word = 'unknown verdict ' + JSON.stringify(String(verdict));
    }
    return 'Accessibility for this run: ' + word + exitNote + (where ? ', ' + where : '') + '.';
  }

  // What the header says under the verdict: one plain line for most states, or a short list of
  // lines when one sentence cannot carry the facts. Every line either states a fact or states plainly
  // that usabl does not know.
  function explanationFor(payload, error, scanning, split) {
    const explanation = stateExplanation(payload, error, scanning, split);
    const lines = Array.isArray(explanation) ? explanation : [explanation];
    // A gap the panel could not place. Attributing it to this screen would be a guess, and hiding it
    // would let an unchecked page read as checked. So it is named as unplaced, in every loaded state.
    if (!scanning && !error && payload && payload.loaded && split.unattributedGaps > 0) {
      lines.push(unattributedGapLine(split.unattributedGaps));
    }
    return lines;
  }

  function unattributedGapLine(count) {
    return 'usabl reported ' + (count === 1 ? 'a coverage gap' : count + ' coverage gaps')
      + ' that this panel could not attribute to a screen; see the coverage gaps below.';
  }

  function stateExplanation(payload, error, scanning, split) {
    if (scanning) {
      return 'usabl is scanning the screens your change affects.';
    }
    if (error) {
      return 'usabl could not load a result, so it can say nothing about this screen. Check the dev server log.';
    }
    if (!payload || !payload.loaded) {
      return 'usabl has not loaded a result yet.';
    }
    const verdict = verdictFor(payload, error, scanning);
    if (verdict.key === 'not-covered') {
      return 'usabl could not check the affected screens, so nothing here is proven.';
    }
    if (verdict.key === 'approval') {
      return approvalLines(payload, split);
    }
    if (verdict.key === 'no-verdict') {
      // A run that ended without a verdict proved nothing, whatever the screen looks like. The exit
      // code is already beside the verdict word, and the engine's reason is the one section below.
      return 'usabl finished without a verdict, so nothing on this screen is proven.';
    }
    if (verdict.key === 'idle') {
      // Checked before the not-matched branch on purpose. When the run had nothing to check, no
      // screen was scanned, so "this screen was not scanned" is true but tells the developer the
      // wrong thing: the reason is the change, not the screen.
      return 'Your change touched no screen usabl checks, so this run had nothing to check.';
    }
    if (split.gap) {
      // In scope, but not checked. The reason is the fact that matters, so it is quoted.
      return gapLine(split.gap);
    }
    if (!split.matched) {
      return verdict.key === 'verified'
        ? 'Verified, but this screen was not part of the last scan, so that verdict does not cover it.'
        : unaffectedLine(payload, split);
    }
    if (verdict.key === 'verified') {
      // A verified Result can still carry waived and already-fixed findings. Saying "no findings"
      // beside a list of them contradicts the list, so name the gating lane instead.
      const base = split.here.length > 0 || split.elsewhereTotal > 0
        ? 'No new gating findings. The findings listed are accepted, waived, or already fixed.'
        : 'No findings on any screen usabl checked.';
      return payload.receipt ? base + ' The receipt below records what that covered.' : base;
    }
    // Blocking verdict from here down.
    if (split.here.length === 0) {
      return split.elsewhereTotal > 0
        ? 'No findings on this screen, but other screens have findings and the gate is blocked.'
        : 'No findings on this screen, and usabl still reports ' + verdict.word.toLowerCase() + '.';
    }
    return 'usabl found ' + countLabel(split.here.length, 'accessibility barrier') + ' on this screen.';
  }

  // What the collapsed badge says.
  //
  // The global verdict dominates. A clean current screen never earns the clear tick while the run
  // as a whole is blocked, because the badge is the only thing a developer sees until they open the
  // panel, and a green badge over a regression is the false green this product exists to stop.
  // The local count is still shown, because it is the number they can act on where they stand.
  function badgeView(payload, error, scanning, split) {
    const verdict = verdictFor(payload, error, scanning);
    if (scanning) {
      return { key: 'scanning', symbol: '…', count: null, label: 'usabl: scanning. Open inspector.' };
    }
    if (error) {
      return { key: 'error', symbol: '!', count: null, label: 'usabl: could not load a result. Open inspector.' };
    }
    if (!payload || !payload.loaded) {
      return { key: 'pending', symbol: '○', count: null, label: 'usabl: no result yet. Open inspector.' };
    }

    const word = verdict.word.toLowerCase();
    if (!isSettledClean(verdict.key)) {
      if (split.matched && split.here.length > 0) {
        return {
          key: verdict.key,
          symbol: '✕',
          count: split.here.length,
          label: 'usabl: ' + word + ', ' + countLabel(split.here.length, 'issue')
            + ' on this screen. Open inspector.',
        };
      }
      if (split.matched && split.gap) {
        // In scope but not checked. "No issues on this screen" would read as clean.
        return {
          key: verdict.key,
          symbol: '!',
          count: null,
          label: 'usabl: ' + word + '. usabl could not check this screen. Open inspector.',
        };
      }
      if (split.matched) {
        return {
          key: verdict.key,
          symbol: '!',
          count: null,
          label: 'usabl: ' + word + ' elsewhere, no issues on this screen. Open inspector.',
        };
      }
      return {
        key: verdict.key,
        symbol: '!',
        count: null,
        label: 'usabl: ' + word + '. This screen was not scanned. Open inspector.',
      };
    }

    // Settled clean from here down: verified, or a run that genuinely had nothing to check.
    if (!split.matched) {
      return {
        key: 'unscanned',
        symbol: '?',
        count: null,
        label: 'usabl: ' + word + ', but this screen was not scanned. Open inspector.',
      };
    }
    if (split.here.length > 0) {
      // Verified with waived or already-fixed findings on this screen. They are listed, so the count
      // has to appear, but calling them issues would contradict the verdict beside them.
      return {
        key: 'clear',
        symbol: '✓',
        count: split.here.length,
        label: 'usabl: ' + word + ', ' + countLabel(split.here.length, 'non-gating finding')
          + ' on this screen. Open inspector.',
      };
    }
    return {
      key: 'clear',
      symbol: '✓',
      count: null,
      label: 'usabl: ' + word + ', no issues on this screen. Open inspector.',
    };
  }

  const OVERLAY_STYLE = \`
      :host {
        color-scheme: light;
        --ink: #101827;
        --ink-surface: #172033;
        --paper: #f7f5ef;
        --white: #ffffff;
        --cobalt: #2457e6;
        --cobalt-light: #dfe7ff;
        --cobalt-ink: #173d9f;
        --green: #177a4a;
        --green-light: #e6f4ed;
        --green-ink: #0f5a36;
        --red: #c9363e;
        --red-light: #fbeaec;
        --red-ink: #9f252d;
        --amber: #a95f00;
        --amber-light: #fff1d7;
        --amber-ink: #754200;
        --violet-light: #f0eafa;
        --violet-ink: #54388c;
        --slate: #596579;
        --graphite: #344054;
        --rule: #cbd2de;
        --mute: #e8ebf0;
        --mute-ink: #3d485a;
        --on-dark: #dce3ef;
        font-family: system-ui, "Segoe UI", Arial, sans-serif;
        font-size: 16px;
        line-height: 1.5;
        text-rendering: optimizeLegibility;
      }

      *, *::before, *::after {
        box-sizing: border-box;
      }

      button {
        font: inherit;
      }

      h2, h3, h4, p, dl, dd, ul {
        margin: 0;
      }

      /* The host is click-through so the collapsed badge never blocks the app underneath it. Only
         the badge itself and the open panel take pointer events. */
      .shell {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        max-height: calc(100vh - 24px);
        color: var(--ink);
        pointer-events: none;
      }

      .badge,
      .panel {
        pointer-events: auto;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-width: 44px;
        min-height: 44px;
        padding: 0 14px;
        border: 1px solid var(--ink);
        border-radius: 999px;
        background: var(--ink);
        color: var(--white);
        font-size: 0.9375rem;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 4px 10px rgba(16, 24, 39, 0.28);
        transition: background-color 160ms ease-out, transform 160ms ease-out;
      }

      .badge:hover {
        background: var(--ink-surface);
      }

      .badge:active {
        transform: translateY(1px);
      }

      .badge[hidden] {
        display: none;
      }

      .badge-word {
        font-size: 0.9375rem;
        font-weight: 700;
        letter-spacing: 0.01em;
        line-height: 1;
      }

      .badge-symbol {
        font-size: 1.0625rem;
        line-height: 1;
      }

      .badge[data-state="clear"] .badge-symbol {
        color: #7ee2b0;
      }

      .badge[data-state="regression"] .badge-symbol,
      .badge[data-state="no-verdict"] .badge-symbol,
      .badge[data-state="error"] .badge-symbol {
        color: #ff9ba2;
      }

      .badge[data-state="not-covered"] .badge-symbol,
      .badge[data-state="unscanned"] .badge-symbol,
      .badge[data-state="approval"] .badge-symbol {
        color: #ffd18a;
      }

      /* The badge gets louder when the run has something a developer must act on: a solid fill
         instead of the calm dark pill. Colour only reinforces the wordmark and glyph, which still
         carry the meaning on their own, so this adds no colour-only signal. Clean, idle, pending,
         scanning, and unscanned stay calm. */
      .badge[data-state="regression"],
      .badge[data-state="no-verdict"],
      .badge[data-state="error"] {
        background: var(--red);
        border-color: var(--red);
      }

      .badge[data-state="regression"]:hover,
      .badge[data-state="no-verdict"]:hover,
      .badge[data-state="error"]:hover {
        background: #ad2c33;
      }

      .badge[data-state="approval"],
      .badge[data-state="not-covered"] {
        background: var(--amber);
        border-color: var(--amber);
      }

      .badge[data-state="approval"]:hover,
      .badge[data-state="not-covered"]:hover {
        background: #8c4f00;
      }

      /* On a filled badge the glyph joins the white wordmark; the tinted glyph colours above are for
         the dark pill only. */
      .badge[data-state="regression"] .badge-symbol,
      .badge[data-state="no-verdict"] .badge-symbol,
      .badge[data-state="error"] .badge-symbol,
      .badge[data-state="approval"] .badge-symbol,
      .badge[data-state="not-covered"] .badge-symbol {
        color: var(--white);
      }

      .panel {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-height: calc(100vh - 24px);
        overflow: hidden;
        border: 1px solid var(--ink-surface);
        border-radius: 12px;
        background: var(--paper);
        color: var(--ink);
        box-shadow: 0 6px 18px rgba(16, 24, 39, 0.24);
      }

      .panel[hidden] {
        display: none;
      }

      .panel:focus-visible,
      .badge:focus-visible,
      .icon-button:focus-visible,
      .finding-button:focus-visible,
      .detail-action:focus-visible,
      .elsewhere-link:focus-visible,
      .editor-link:focus-visible {
        outline: 3px solid var(--cobalt);
        outline-offset: 2px;
      }

      /* The badge sits on the host app's content, which can be any colour, so a single-colour ring
         can land at 1:1 against it and disappear. Two rings, white inside dark, keeps one of the two
         edges visible against light and dark alike. */
      .badge:focus-visible {
        outline: 3px solid var(--white);
        outline-offset: 0;
        box-shadow: 0 0 0 6px var(--ink), 0 0 0 8px var(--white);
      }

      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        border: 0;
        overflow: hidden;
        white-space: nowrap;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
      }

      .tamper-notice {
        border-top: 0;
        border-bottom: 3px solid var(--amber);
        background: var(--amber-light);
      }

      .tamper-notice h3 {
        color: var(--amber-ink);
      }

      .more-note {
        margin-top: 10px;
        color: var(--slate);
        font-size: 0.75rem;
      }

      .more-button {
        margin-top: 8px;
      }

      .more-button[hidden] {
        display: none;
      }

      .elsewhere-nolink {
        color: var(--amber-ink);
        font-size: 0.75rem;
        font-weight: 650;
      }

      .panel-header {
        flex: 0 0 auto;
        padding: 14px 16px 15px;
        background: var(--ink);
        color: var(--white);
      }

      .panel-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      h2 {
        font-size: 0.9375rem;
        font-weight: 760;
        letter-spacing: -0.01em;
        line-height: 1.3;
      }

      .panel-controls {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* 44px on every control. WCAG 2.2 AA asks for 24px; this is deliberately larger so the panel
         is comfortable on a touch screen and on a trackpad. */
      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 44px;
        min-height: 44px;
        padding: 0 10px;
        border: 1px solid #3d4a61;
        border-radius: 8px;
        background: var(--ink-surface);
        color: var(--white);
        font-size: 0.8125rem;
        font-weight: 700;
        cursor: pointer;
      }

      .icon-button:hover {
        background: #22304a;
      }

      .icon-button[aria-pressed="true"] {
        border-color: var(--white);
        background: var(--white);
        color: var(--ink);
      }

      .banner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }

      .banner-verdict {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 28px;
        padding: 3px 11px;
        border-radius: 999px;
        font-size: 0.875rem;
        font-weight: 760;
        letter-spacing: -0.01em;
        white-space: nowrap;
      }

      .banner[data-state="verified"] .banner-verdict { background: var(--green-light); color: var(--green-ink); }
      .banner[data-state="regression"] .banner-verdict,
      .banner[data-state="no-verdict"] .banner-verdict,
      .banner[data-state="error"] .banner-verdict { background: var(--red-light); color: var(--red-ink); }
      .banner[data-state="pending"] .banner-verdict { background: var(--mute); color: var(--mute-ink); }
      .banner[data-state="not-covered"] .banner-verdict { background: var(--amber-light); color: var(--amber-ink); }
      .banner[data-state="approval"] .banner-verdict { background: var(--violet-light); color: var(--violet-ink); }
      .banner[data-state="scanning"] .banner-verdict { background: var(--cobalt-light); color: var(--cobalt-ink); }
      .banner[data-state="idle"] .banner-verdict { background: var(--mute); color: var(--mute-ink); }

      .banner-exit {
        color: var(--on-dark);
        font-size: 0.75rem;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      }

      .banner-note {
        margin-top: 9px;
        max-width: 66ch;
        color: var(--on-dark);
        font-size: 0.8125rem;
        overflow-wrap: anywhere;
        text-wrap: pretty;
      }

      .screen-line {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 10px;
        margin-top: 11px;
        padding-top: 10px;
        border-top: 1px solid #2b3549;
      }

      .screen-label {
        color: var(--white);
        font-size: 0.8125rem;
        font-weight: 700;
      }

      .screen-path {
        color: var(--on-dark);
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.75rem;
        overflow-wrap: anywhere;
      }

      .screen-counts {
        margin-left: auto;
        color: var(--on-dark);
        font-size: 0.75rem;
        white-space: nowrap;
      }

      .panel-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .locate-status {
        padding: 10px 16px;
        border-bottom: 1px solid var(--rule);
        background: var(--cobalt-light);
        color: var(--ink);
        font-size: 0.8125rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .locate-status:empty {
        display: none;
      }

      .locate-selector {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.75rem;
      }

      .section {
        padding: 14px 16px;
        border-top: 1px solid var(--rule);
      }

      .section:first-child {
        border-top: 0;
      }

      .section-heading {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }

      h3 {
        font-size: 0.9375rem;
        line-height: 1.35;
      }

      h4 {
        color: var(--slate);
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }

      .section-count {
        color: var(--slate);
        font-size: 0.75rem;
        white-space: nowrap;
      }

      /* The list scrolls inside its own bounded box, so a screen with forty findings never pushes
         the coverage footer off the bottom of the window. No hard cap on how many rows exist. */
      .finding-scroll {
        max-height: 46vh;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .finding-list {
        display: grid;
        gap: 6px;
        padding: 0;
        list-style: none;
      }

      .finding-item {
        display: grid;
      }

      .finding-button {
        display: flex;
        align-items: center;
        gap: 9px;
        width: 100%;
        min-height: 44px;
        padding: 10px 11px;
        border: 1px solid var(--rule);
        border-radius: 8px;
        background: var(--white);
        color: var(--ink);
        text-align: left;
        cursor: pointer;
        transition: border-color 140ms ease-out, background-color 140ms ease-out;
      }

      .finding-button:hover {
        border-color: var(--cobalt);
        background: #f6f8ff;
      }

      .finding-button[aria-expanded="true"] {
        align-items: flex-start;
        border-color: var(--cobalt);
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
        background: #f6f8ff;
      }

      .severity-dot {
        flex: 0 0 auto;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--slate);
      }

      .finding-button[aria-expanded="true"] .severity-dot {
        margin-top: 6px;
      }

      .finding-button[data-severity="critical"] .severity-dot { background: #8f2027; }
      .finding-button[data-severity="serious"] .severity-dot { background: var(--red); }
      .finding-button[data-severity="moderate"] .severity-dot { background: var(--amber); }
      .finding-button[data-severity="minor"] .severity-dot { background: var(--slate); }

      .severity-word {
        flex: 0 0 auto;
        min-width: 4.5em;
        color: var(--graphite);
        font-size: 0.75rem;
        font-weight: 760;
        letter-spacing: 0.01em;
        text-transform: uppercase;
      }

      .finding-button[aria-expanded="true"] .severity-word {
        padding-top: 1px;
      }

      .finding-title-wrap {
        flex: 1 1 auto;
        min-width: 0;
      }

      /* Collapsed rows clamp the title to one line. The full string stays in the DOM, so the
         accessible name is never the truncated version, and expanding simply drops the clamp. */
      .finding-title {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
        overflow: hidden;
        min-width: 0;
        font-size: 0.875rem;
        font-weight: 650;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .finding-button[aria-expanded="true"] .finding-title {
        display: block;
        overflow: visible;
        text-wrap: pretty;
      }

      .finding-detail {
        display: grid;
        gap: 10px;
        padding: 12px 12px 13px;
        border: 1px solid var(--cobalt);
        border-top: 0;
        border-bottom-left-radius: 8px;
        border-bottom-right-radius: 8px;
        background: var(--white);
      }

      .finding-detail[hidden] {
        display: none;
      }

      .detail-block p {
        margin-top: 3px;
        color: var(--graphite);
        font-size: 0.8125rem;
        line-height: 1.45;
        overflow-wrap: anywhere;
        text-wrap: pretty;
      }

      .detail-selector {
        display: block;
        margin-top: 3px;
        color: var(--ink);
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.75rem;
        overflow-wrap: anywhere;
      }

      .detail-meta {
        color: var(--slate);
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.6875rem;
        overflow-wrap: anywhere;
      }

      .detail-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .detail-action {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 0 13px;
        border: 1px solid var(--cobalt);
        border-radius: 8px;
        background: var(--white);
        color: #1745bd;
        font-size: 0.8125rem;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      }

      .detail-action:hover {
        background: var(--cobalt-light);
      }

      .editor-link {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        color: #1745bd;
        font-size: 0.8125rem;
        font-weight: 700;
        text-decoration: underline;
      }

      .elsewhere-lead {
        margin-bottom: 10px;
        color: var(--graphite);
        font-size: 0.8125rem;
        line-height: 1.45;
        text-wrap: pretty;
      }

      .elsewhere-list {
        display: grid;
        gap: 6px;
        padding: 0;
        list-style: none;
      }

      .elsewhere-item {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 6px 12px;
        padding: 9px 11px;
        border: 1px solid var(--rule);
        border-radius: 8px;
        background: var(--white);
      }

      .elsewhere-info {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 8px;
        min-width: 0;
      }

      .elsewhere-name {
        font-size: 0.875rem;
        font-weight: 680;
        overflow-wrap: anywhere;
      }

      .elsewhere-count {
        display: inline-flex;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--red-light);
        color: var(--red-ink);
        font-size: 0.6875rem;
        font-weight: 700;
      }

      .elsewhere-worst {
        color: var(--slate);
        font-size: 0.6875rem;
        font-weight: 650;
        text-transform: uppercase;
      }

      .elsewhere-path {
        width: 100%;
        color: var(--slate);
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.6875rem;
        overflow-wrap: anywhere;
      }

      .elsewhere-link {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 0 13px;
        border: 1px solid var(--cobalt);
        border-radius: 8px;
        background: var(--white);
        color: #1745bd;
        font-size: 0.8125rem;
        font-weight: 700;
        text-decoration: none;
        white-space: nowrap;
      }

      .elsewhere-link:hover {
        background: var(--cobalt-light);
        text-decoration: underline;
      }

      .coverage-footer {
        background: #f1efe8;
      }

      .coverage-list,
      .receipt-grid {
        display: grid;
        grid-template-columns: minmax(110px, 0.8fr) minmax(0, 1.2fr);
        gap: 8px 12px;
        font-size: 0.8125rem;
      }

      dt {
        color: var(--slate);
        font-weight: 650;
      }

      dd {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .screen-list,
      .path-list,
      .gap-list {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        padding: 0;
        list-style: none;
      }

      .screen-token,
      .path-token {
        display: inline-flex;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--cobalt-light);
        color: var(--cobalt-ink);
        font-size: 0.75rem;
        font-weight: 650;
      }

      .path-token {
        background: var(--mute);
        color: var(--mute-ink);
      }

      .gap-list {
        display: grid;
        gap: 6px;
      }

      .gap-item {
        padding: 7px 9px;
        border: 1px solid #e0b46b;
        border-radius: 8px;
        background: var(--amber-light);
        color: #603700;
        overflow-wrap: anywhere;
      }

      .empty {
        color: var(--slate);
        font-size: 0.8125rem;
      }

      .receipt {
        background: var(--green-light);
      }

      .receipt h3 {
        color: var(--green-ink);
      }

      .receipt-grid {
        margin-top: 10px;
      }

      .notice {
        color: var(--graphite);
        font-size: 0.8125rem;
        line-height: 1.45;
        text-wrap: pretty;
      }

      .loading-line {
        height: 10px;
        margin-top: 8px;
        border-radius: 4px;
        background: #dce1e9;
      }

      .loading-line:nth-child(3) {
        width: 72%;
      }

      @media (max-width: 520px) {
        :host {
          font-size: 15px;
        }

        .panel-header,
        .section,
        .locate-status {
          padding-left: 13px;
          padding-right: 13px;
        }

        .finding-scroll {
          max-height: 38vh;
        }

        .coverage-list,
        .receipt-grid {
          grid-template-columns: 1fr;
          gap: 3px;
        }

        dd + dt {
          margin-top: 7px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          scroll-behavior: auto !important;
          transition-duration: 0.01ms !important;
        }
      }
    \`;

  function ensureInspector() {
    // The reference we created, never a lookup by id. A page that pre-creates an element with our
    // id can no longer take the overlay's place, and a page that rips our node out of the document
    // gets a fresh one rather than a silent, invisible inspector.
    if (state.host && state.host.isConnected && state.host.shadowRoot) {
      return state.host;
    }

    const host = document.createElement('aside');
    host.id = HOST_ID;
    host.setAttribute(HOST_ATTRIBUTE, '');
    host.setAttribute('aria-label', 'usabl development tools');
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    // The corner insets are set by applyDock once the shadow root exists, so the badge and panel dock
    // to the persisted corner and can be moved later.
    host.style.setProperty('width', 'auto', 'important');
    host.style.setProperty('max-height', 'calc(100vh - 24px)', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    // Click-through by default so the collapsed badge cannot swallow a click meant for the app.
    // The badge and the open panel opt back in through the shadow stylesheet.
    host.style.setProperty('pointer-events', 'none', 'important');

    // An open shadow root on purpose. A closed root would not stop a page that runs before us from
    // hooking Element.prototype.attachShadow, so it buys no real protection, and it would hide the
    // overlay's own interface from axe-core and from every automated accessibility check. For an
    // accessibility tool, being unable to prove its own interface is accessible is the worse trade.
    let shadow;
    try {
      shadow = host.attachShadow({ mode: 'open' });
    } catch (attachError) {
      // Fail loudly. An inspector that silently renders nothing hides findings from a developer who
      // has every reason to believe the screen is clean.
      nativeConsoleError(
        'usabl inspector could not attach its shadow root, so the in-page inspector is not showing. '
          + 'Findings are still reported by usabl check and by the gate. Cause: '
          + (attachError && attachError.message ? attachError.message : String(attachError)),
      );
      return null;
    }
    const style = document.createElement('style');
    style.textContent = OVERLAY_STYLE;

    const shell = make('div', 'shell');

    const badge = make('button', 'badge');
    badge.type = 'button';
    badge.setAttribute('aria-controls', PANEL_ID);
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-label', 'usabl: no result yet. Open inspector.');
    badge.addEventListener('click', () => setOpen(host, true, true));

    const panel = make('section', 'panel');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-labelledby', TITLE_ID);
    panel.tabIndex = -1;
    panel.hidden = true;

    // The header and the body are refilled on every render. The status region is created once and
    // never replaced: a live region that is removed and recreated is not reliably announced, and
    // this one is how a screen reader user learns whether a locate succeeded.
    const header = make('header', 'panel-header');
    const liveStatus = make('p', 'locate-status');
    liveStatus.setAttribute('role', 'status');
    liveStatus.setAttribute('aria-live', 'polite');
    const body = make('div', 'panel-body');

    // A second, visually hidden live region for the verdict itself. Without it a screen reader user
    // watching a fix loop hears nothing: the banner changes from regression to verified silently.
    // It is written only when the sentence actually changes, so a re-render does not repeat it.
    //
    // It lives on the shell, OUTSIDE the panel, on purpose. The panel is hidden while the overlay is
    // collapsed, and a live region inside a hidden subtree is not in the accessibility tree, so its
    // updates are never announced. Collapsed is the normal state during a fix loop, so a verdict
    // going from regression to verified while collapsed must still be announced. Keeping the region
    // on the always-present shell is what lets that happen.
    const verdictStatus = make('p', 'visually-hidden');
    verdictStatus.setAttribute('role', 'status');
    verdictStatus.setAttribute('aria-live', 'polite');

    panel.appendChild(header);
    panel.appendChild(liveStatus);
    panel.appendChild(body);
    state.liveStatus = liveStatus;
    state.verdictStatus = verdictStatus;

    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) {
        event.preventDefault();
        setOpen(host, false, true);
      }
    });

    shell.appendChild(badge);
    shell.appendChild(panel);
    // Outside the panel so it keeps announcing while the panel is hidden and the overlay is collapsed.
    shell.appendChild(verdictStatus);
    shadow.appendChild(style);
    shadow.appendChild(shell);
    document.body.appendChild(host);
    state.host = host;

    state.open = storedValue(OPEN_STORAGE_KEY) === '1';
    state.wide = storedValue(WIDE_STORAGE_KEY) === '1';
    state.dock = normalizeDock(storedValue(DOCK_STORAGE_KEY));
    applyDock(host);
    return host;
  }

  // Opening and closing only flips visibility, so the panel content the user was reading is still
  // there when they come back. Closing collapses the open row and drops the highlight, which keeps
  // the rule that a highlighted element always has an expanded row explaining it.
  function setOpen(host, open, viaUser) {
    state.open = open;
    storeValue(OPEN_STORAGE_KEY, open ? '1' : '0');
    if (!open) {
      state.expandedKey = null;
      applyRowState();
      clearLocateStatus();
    }
    syncOpen(host, viaUser);
  }

  function setWide(host, wide) {
    state.wide = wide;
    storeValue(WIDE_STORAGE_KEY, wide ? '1' : '0');
    const toggle = host.shadowRoot.querySelector('.width-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(wide));
    }
    syncOpen(host, false);
  }

  function syncOpen(host, moveFocus) {
    const shadow = host.shadowRoot;
    const badge = shadow.querySelector('.badge');
    const panel = shadow.querySelector('.panel');
    badge.hidden = state.open;
    badge.setAttribute('aria-expanded', String(state.open));
    panel.hidden = !state.open;
    host.style.setProperty(
      'width',
      state.open ? (state.wide ? WIDE_WIDTH : COMPACT_WIDTH) : 'auto',
      'important',
    );
    if (!state.open) {
      clearHighlight();
    }
    if (!moveFocus) {
      return;
    }
    // The control the user just pressed is now hidden, so focus has to be placed deliberately or it
    // falls to the document and a keyboard user loses their position.
    if (state.open) {
      panel.focus();
    } else {
      badge.focus();
    }
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function normalizeDock(value) {
    return DOCK_CORNERS.indexOf(value) === -1 ? DEFAULT_DOCK : value;
  }

  // Pin the host to one corner. Only the two edges the corner touches get an inset; the opposite
  // edges are cleared to auto so the panel is never stretched across the viewport.
  function applyDock(host) {
    const dock = normalizeDock(state.dock);
    const top = dock === 'top-left' || dock === 'top-right';
    const left = dock === 'top-left' || dock === 'bottom-left';
    host.style.setProperty('top', top ? DOCK_INSET : 'auto', 'important');
    host.style.setProperty('bottom', top ? 'auto' : DOCK_INSET, 'important');
    host.style.setProperty('left', left ? DOCK_INSET : 'auto', 'important');
    host.style.setProperty('right', left ? 'auto' : DOCK_INSET, 'important');
    // The shell stacks the badge and panel to the docked edge, so the badge sits at the same corner
    // as the panel and the panel does not jump when it opens.
    const shell = host.shadowRoot && host.shadowRoot.querySelector('.shell');
    if (shell) {
      shell.style.alignItems = left ? 'flex-start' : 'flex-end';
    }
  }

  // Move the panel to a corner, persist it, and update the dock control's label. Repositioning is
  // instant. There is no slide, which is also what prefers-reduced-motion requires, so nothing here
  // animates in either motion setting.
  function setDock(host, dock) {
    state.dock = normalizeDock(dock);
    storeValue(DOCK_STORAGE_KEY, state.dock);
    applyDock(host);
    const control = host.shadowRoot && host.shadowRoot.querySelector('.dock-toggle');
    if (control) {
      control.setAttribute('aria-label', 'Move panel. Now at ' + DOCK_LABELS[state.dock] + '.');
    }
  }

  // The panel's current viewport rectangle, or null when it is not open. Used by auto-dodge to tell
  // whether the panel is covering the element the user asked to see.
  function panelRect(host) {
    const panel = host.shadowRoot && host.shadowRoot.querySelector('.panel');
    if (!panel || panel.hidden) {
      return null;
    }
    return panel.getBoundingClientRect();
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  // The rectangle the panel would occupy docked at a corner, using the panel's real size and the
  // real inset from the viewport edges. The inset is part of the geometry: a candidate drawn flush
  // to the edge is 12px off from where the panel really lands, and for a target that crosses that
  // 12px band the flush rectangle reads clear while the real one still overlaps.
  function dockedRect(corner, width, height) {
    const inset = DOCK_INSET_PX;
    const top = corner === 'top-left' || corner === 'top-right';
    const left = corner === 'top-left' || corner === 'bottom-left';
    const x = left ? inset : window.innerWidth - inset - width;
    const y = top ? inset : window.innerHeight - inset - height;
    return { left: x, right: x + width, top: y, bottom: y + height };
  }

  // If the panel is covering the target, move it to the corner farthest from the target that does
  // not overlap it. Called after the target has been scrolled into view, so the rectangles are the
  // ones the user is actually looking at.
  //
  // Returns 'clear' when the panel was not in the way, 'moved' when it moved, and 'blocked' when
  // every corner would still overlap, for example a target that spans the viewport. In that case
  // the dock is left where it is rather than moved somewhere no better, and the caller says so.
  function dodgePanelAwayFrom(host, target) {
    const panel = panelRect(host);
    if (panel === null) {
      return 'clear';
    }
    const targetRect = target.getBoundingClientRect();
    if (!rectsOverlap(panel, targetRect)) {
      return 'clear';
    }
    const width = panel.width;
    const height = panel.height;
    const targetCenter = {
      x: (targetRect.left + targetRect.right) / 2,
      y: (targetRect.top + targetRect.bottom) / 2,
    };
    let best = null;
    let bestDistance = -1;
    for (const corner of DOCK_CORNERS) {
      const candidate = dockedRect(corner, width, height);
      if (rectsOverlap(candidate, targetRect)) {
        continue;
      }
      // Distance from the target's centre to the panel's inner corner, the point of the panel that
      // sits closest to the middle of the screen.
      const left = corner === 'top-left' || corner === 'bottom-left';
      const top = corner === 'top-left' || corner === 'top-right';
      const dx = (left ? candidate.right : candidate.left) - targetCenter.x;
      const dy = (top ? candidate.bottom : candidate.top) - targetCenter.y;
      const distance = dx * dx + dy * dy;
      if (distance > bestDistance) {
        bestDistance = distance;
        best = corner;
      }
    }
    if (best === null) {
      return 'blocked';
    }
    if (best !== state.dock) {
      setDock(host, best);
    }
    return 'moved';
  }

  // Run a callback once a smooth scroll toward the target has finished, so the geometry it reads is
  // the geometry the user ends up looking at. A fixed number of animation frames is not enough: a
  // long smooth scroll is still moving after two frames, the panel is judged clear against a
  // position the target has not reached, and the target ends up under it with no warning.
  //
  // scrollend is used where the browser fires it. Because a target already in view scrolls nothing
  // and fires no scrollend, and because not every browser fires it, the wait also ends when no
  // scroll event has arrived within a few frames, or when the target's rectangle has held still for
  // a few frames after scrolling, and in any case after about one second.
  function afterScrollSettles(target, callback) {
    let done = false;
    let sawScroll = false;
    let frames = 0;
    let stableFrames = 0;
    let lastRect = '';
    const startedAt = Date.now();
    const onScroll = () => {
      sawScroll = true;
    };
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('scrollend', finish, true);
      callback();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('scrollend', finish, true);
    const tick = () => {
      if (done) {
        return;
      }
      frames += 1;
      const rect = target.getBoundingClientRect();
      const key = rect.left + ',' + rect.top + ',' + rect.width + ',' + rect.height;
      stableFrames = key === lastRect ? stableFrames + 1 : 0;
      lastRect = key;
      if (!sawScroll && frames >= 4) {
        // Nothing scrolled, so the geometry was final from the start.
        finish();
        return;
      }
      if (sawScroll && stableFrames >= 3) {
        finish();
        return;
      }
      if (Date.now() - startedAt >= 1000) {
        finish();
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }

  const DODGE_BLOCKED_TEXT =
    'The panel covers part of it and no corner is clear. Collapse the panel or use Move to see it.';

  // Put back exactly the element we borrowed a tabindex from, with exactly the value it had.
  //
  // The previous version queried the whole document for a marker attribute and stripped tabindex
  // from everything it found. That mutates page-owned elements that happen to carry the marker, and
  // it misses an element that detached and reattached, leaving a stray tabindex behind. Ownership is
  // a reference we hold, never a selector we run.
  function releaseBorrowedTabindex() {
    const borrowed = state.borrowedTabindex;
    state.borrowedTabindex = null;
    if (!borrowed) {
      return;
    }
    try {
      if (borrowed.previous === null) {
        borrowed.node.removeAttribute('tabindex');
      } else {
        borrowed.node.setAttribute('tabindex', borrowed.previous);
      }
    } catch (_error) {
      // The node may be gone or frozen. Nothing more we can honestly do about its attributes.
    }
  }

  function clearHighlight() {
    if (typeof state.highlightCleanup === 'function') {
      state.highlightCleanup();
      state.highlightCleanup = null;
    }
    state.highlightKey = null;
    if (state.marker) {
      state.marker.remove();
      state.marker = null;
    }
    releaseBorrowedTabindex();
  }

  function setLocateStatus(text, selector) {
    const region = state.liveStatus;
    if (!region) {
      return;
    }
    region.replaceChildren(document.createTextNode(text));
    if (selector) {
      const code = document.createElement('code');
      code.className = 'locate-selector';
      code.textContent = selector;
      region.appendChild(document.createTextNode(' '));
      region.appendChild(code);
    }
  }

  function clearLocateStatus() {
    if (state.liveStatus) {
      state.liveStatus.replaceChildren();
    }
  }

  // Look up the flagged element on the live page. Not found covers: a selector the browser rejects,
  // an element that has since been removed, the overlay's own host, anything inside it, and any
  // ANCESTOR of it. The ancestor case is the one that bit us: a selector such as
  // "body:has(#__usabl-overlay)" matched body itself, so locating put a borrowed tabindex on body
  // and scrolled the whole document. An element that contains the inspector is never the element a
  // finding is about.
  function resolveTarget(finding) {
    const selector = displayText(finding.elementPath).trim();
    let target = null;
    try {
      target = selector ? document.querySelector(selector) : null;
    } catch (_error) {
      target = null;
    }
    const inspector = state.host;
    if (
      !target
      || target === inspector
      || (inspector && (inspector.contains(target) || target.contains(inspector)))
    ) {
      return { selector, target: null };
    }
    return { selector, target };
  }

  // Honest status: the finding was true at scan time and the DOM has changed since. We name the
  // selector so a developer can see exactly what was flagged, and we never claim a locate worked.
  function reportMissingElement(selector) {
    setLocateStatus(MISSING_ELEMENT_TEXT, selector);
  }

  function elementLabel(finding, selector) {
    return displayText(finding.elementName) || selector || 'the flagged element';
  }

  // Scroll to the flagged element and outline it. This never moves focus. A developer who activates
  // a row with the keyboard stays in the list; "Move focus to it" is the explicit way to leave it.
  function highlightFinding(finding, key) {
    clearHighlight();
    const found = resolveTarget(finding);
    if (found.target === null) {
      reportMissingElement(found.selector);
      return false;
    }

    const target = found.target;
    const reducedMotion = prefersReducedMotion();
    target.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // Once the target is in view, get the panel out of its way if it is covering it. With reduced
    // motion the scroll is instant, so the rect is final now and the dodge runs at once. With a smooth
    // scroll the rect settles a frame or two later, so the dodge waits for the next frame.
    const highlightedText = 'Highlighted ' + elementLabel(finding, found.selector) + ' on the page.';
    let dodgeOutcome = 'clear';
    if (state.host) {
      if (reducedMotion || typeof window.requestAnimationFrame !== 'function') {
        dodgeOutcome = dodgePanelAwayFrom(state.host, target);
      } else {
        afterScrollSettles(target, () => {
          if (state.host && state.highlightKey === key) {
            if (dodgePanelAwayFrom(state.host, target) === 'blocked') {
              // The status was already written below. Rewrite it once with the extra sentence, so
              // a screen reader user hears why the element is still partly covered.
              setLocateStatus(highlightedText + ' ' + DODGE_BLOCKED_TEXT, '');
            }
          }
        });
      }
    }

    const marker = document.createElement('div');
    marker.id = HIGHLIGHT_ID;
    marker.setAttribute(HIGHLIGHT_ATTRIBUTE, '');
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'pointer-events:none',
      'box-sizing:border-box',
      'border:4px solid #c9363e',
      'border-radius:6px',
      'outline:2px solid #ffffff',
      'outline-offset:1px',
    ].join(';');

    const label = document.createElement('span');
    label.textContent = 'Accessibility problem';
    label.style.cssText = [
      'position:absolute',
      'left:-4px',
      'bottom:calc(100% + 6px)',
      'padding:5px 8px',
      'border-radius:4px',
      'background:#c9363e',
      'color:#ffffff',
      'font:700 13px/1.25 system-ui,Segoe UI,Arial,sans-serif',
      'white-space:nowrap',
    ].join(';');
    marker.appendChild(label);
    document.body.appendChild(marker);
    state.marker = marker;

    const position = () => {
      const rect = target.getBoundingClientRect();
      marker.style.left = Math.max(2, rect.left - 4) + 'px';
      marker.style.top = Math.max(2, rect.top - 4) + 'px';
      marker.style.width = Math.max(8, rect.width + 8) + 'px';
      marker.style.height = Math.max(8, rect.height + 8) + 'px';
      label.style.bottom = rect.top < 42 ? 'auto' : 'calc(100% + 6px)';
      label.style.top = rect.top < 42 ? 'calc(100% + 6px)' : 'auto';
    };
    position();

    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    // No timeout. The highlight stays until the row is closed, another row is opened, the panel is
    // closed, or the route changes. A mark that vanishes on its own is a mark you have to chase.
    state.highlightCleanup = () => {
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
    state.highlightKey = key;
    setLocateStatus(
      dodgeOutcome === 'blocked' ? highlightedText + ' ' + DODGE_BLOCKED_TEXT : highlightedText,
      '',
    );
    return true;
  }

  // The explicit opt in. This moves real keyboard and assistive-technology focus onto the flagged
  // element so a screen reader user hears what the finding is about.
  function focusFinding(finding) {
    const found = resolveTarget(finding);
    if (found.target === null) {
      reportMissingElement(found.selector);
      return;
    }
    const target = found.target;
    // Bring the element into view first, then get the panel out of its way, so a sighted keyboard
    // user can see the element the focus landed on and it is not left behind the panel. Focus itself
    // uses preventScroll because the scrollIntoView above already placed the element.
    const focusReducedMotion = prefersReducedMotion();
    target.scrollIntoView({
      behavior: focusReducedMotion ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // With reduced motion the scroll is instant and the geometry is final now. With a smooth scroll
    // it is not, so the dodge waits for the scroll to settle and rewrites the status once if the
    // panel still cannot get out of the way.
    const dodgeNow = focusReducedMotion || typeof window.requestAnimationFrame !== 'function';
    const dodgeOutcome = state.host && dodgeNow ? dodgePanelAwayFrom(state.host, target) : 'clear';
    const movedText = 'Keyboard focus moved to ' + elementLabel(finding, found.selector) + '.';
    if (state.host && !dodgeNow) {
      afterScrollSettles(target, () => {
        if (state.host && dodgePanelAwayFrom(state.host, target) === 'blocked') {
          setLocateStatus(movedText + ' ' + DODGE_BLOCKED_TEXT, '');
        }
      });
    }
    try {
      // Some flagged elements are not focusable. A temporary tabindex of -1 lets us focus them
      // without adding them to the page's tab order. We record the exact node and the exact value it
      // had, and put that back later, rather than marking it and sweeping the document afterwards.
      if (!target.hasAttribute('tabindex')) {
        releaseBorrowedTabindex();
        state.borrowedTabindex = { node: target, previous: null };
        target.setAttribute('tabindex', '-1');
      }
      target.focus({ preventScroll: true });
    } catch (_error) {
      setLocateStatus('Could not move focus to this element.', found.selector);
      return;
    }
    setLocateStatus(dodgeOutcome === 'blocked' ? movedText + ' ' + DODGE_BLOCKED_TEXT : movedText, '');
  }

  function applyRowState() {
    for (const row of state.rows) {
      const open = row.key === state.expandedKey;
      if (open) {
        fillDetail(row);
      }
      row.button.setAttribute('aria-expanded', String(open));
      row.detail.hidden = !open;
    }
  }

  function rowByKey(key) {
    for (const row of state.rows) {
      if (row.key === key) {
        return row;
      }
    }
    return null;
  }

  // One activation does three things at once: it locates the element on the page, it opens this
  // row's detail, and it closes whichever row was open before. Activating the open row again closes
  // it and takes the highlight away with it, so an outlined element always has an open row.
  function activateRow(key) {
    if (state.expandedKey === key) {
      state.expandedKey = null;
      clearHighlight();
      clearLocateStatus();
      applyRowState();
      return;
    }
    state.expandedKey = key;
    applyRowState();
    const row = rowByKey(key);
    if (row) {
      highlightFinding(row.finding, key);
    }
  }

  function editorDeepLink(workspaceRoot, source) {
    if (!source || !source.file || source.tier !== 'renderer') {
      return null;
    }
    const line = source.line || 1;
    const relative = String(source.file).replace(/^\\//, '');
    const absolute = workspaceRoot
      ? String(workspaceRoot).replace(/\\/$/, '') + '/' + relative
      : relative;
    return 'vscode://file/' + absolute + ':' + line + ':1';
  }

  function appendDetailBlock(parent, heading, text) {
    const value = boundedText(text, MAX_PROSE_CHARS).trim();
    if (!value) {
      return;
    }
    const block = make('div', 'detail-block');
    block.appendChild(make('h4', '', heading));
    block.appendChild(make('p', '', value));
    parent.appendChild(block);
  }

  // Built on first expand, not on render.
  //
  // Every row used to build its whole detail body up front, so a screen with a few thousand findings
  // paid for thousands of paragraphs and buttons that nobody had asked to see. At most one row is
  // open at a time, so at most one detail body needs to exist.
  function fillDetail(row) {
    if (row.filled) {
      return;
    }
    row.filled = true;
    const finding = row.finding;
    const detail = row.detail;

    appendDetailBlock(detail, 'Why this matters', finding.why);
    appendDetailBlock(detail, 'How to fix it', finding.fix);

    const elementBlock = make('div', 'detail-block');
    elementBlock.appendChild(make('h4', '', 'Element'));
    const elementName = boundedText(finding.elementName, MAX_SELECTOR_CHARS).trim();
    elementBlock.appendChild(make('p', '', elementName || 'No accessible name at scan time.'));
    elementBlock.appendChild(
      make('code', 'detail-selector', boundedText(finding.elementPath, MAX_SELECTOR_CHARS)),
    );
    detail.appendChild(elementBlock);

    detail.appendChild(
      make('p', 'detail-meta', finding.rule + ' · ' + finding.layer + ' · ' + finding.severity),
    );

    const actions = make('div', 'detail-actions');
    const showAgain = make('button', 'detail-action', 'Highlight it');
    showAgain.type = 'button';
    showAgain.addEventListener('click', () => highlightFinding(finding, row.key));
    actions.appendChild(showAgain);

    const focusButton = make('button', 'detail-action', 'Move focus to it');
    focusButton.type = 'button';
    focusButton.addEventListener('click', () => focusFinding(finding));
    actions.appendChild(focusButton);

    const editorHref = editorDeepLink(row.workspaceRoot, finding.appSource);
    if (editorHref) {
      const openEditor = make('a', 'editor-link', 'Open in editor');
      openEditor.href = editorHref;
      openEditor.target = '_blank';
      openEditor.rel = 'noopener noreferrer';
      actions.appendChild(openEditor);
    }
    detail.appendChild(actions);
  }

  function renderFindingRow(entry, index, workspaceRoot, total) {
    const finding = entry.finding;
    const rowId = PANEL_ID + '-row-' + index;
    const detailId = PANEL_ID + '-detail-' + index;

    const item = make('li', 'finding-item');
    // The list is built a page at a time, so a screen reader is told where each row sits in the
    // whole list rather than in the part that happens to be built.
    item.setAttribute('aria-setsize', String(total));
    item.setAttribute('aria-posinset', String(index + 1));

    // A real button, so Enter and Space work with no key handling of our own, and the browser
    // reports the expanded state through aria-expanded to the detail it controls.
    const button = make('button', 'finding-button');
    button.type = 'button';
    button.id = rowId;
    button.dataset.severity = severityKey(finding.severity);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', detailId);

    const dot = make('span', 'severity-dot');
    dot.setAttribute('aria-hidden', 'true');
    button.appendChild(dot);
    // The severity WORD sits next to the dot, so severity is never carried by colour alone.
    button.appendChild(make('span', 'severity-word', severityWord(finding.severity)));
    // The clamped title sits inside a wrapper rather than being a flex child itself, because a flex
    // item is blockified and the line clamp would never take effect.
    const titleWrap = make('span', 'finding-title-wrap');
    titleWrap.appendChild(
      make('span', 'finding-title', boundedText(finding.whatUserExperiences, MAX_TITLE_CHARS)),
    );
    button.appendChild(titleWrap);

    const detail = make('div', 'finding-detail');
    detail.id = detailId;
    detail.hidden = true;

    button.addEventListener('click', () => activateRow(entry.key));

    item.appendChild(button);
    item.appendChild(detail);
    return { item, button, detail, key: entry.key, finding, workspaceRoot, filled: false };
  }

  // The current-screen section: every finding on this screen, worst first, one row each. This is
  // where the developer works, so nothing is grouped away and nothing is hidden behind a budget.
  function renderCurrentScreen(payload, split) {
    const section = make('section', 'section current-screen');
    const heading = make('div', 'section-heading');
    heading.appendChild(make('h3', '', 'Issues on this screen'));

    if (split.gap) {
      // In scope but not checked. An empty list here must not read as a clean screen.
      section.appendChild(heading);
      section.appendChild(
        make(
          'p',
          'empty',
          'usabl could not check this screen: ' + gapReason(split.gap)
            + '. There is nothing to list. See the coverage gaps below.',
        ),
      );
      return section;
    }

    if (!split.matched) {
      section.appendChild(heading);
      const verdict = verdictFor(payload, false, false);
      section.appendChild(
        make(
          'p',
          'empty',
          verdict.key === 'not-covered'
            ? 'usabl could not check the affected screens, so there is nothing to list.'
            : unaffectedBodyLine(payload),
        ),
      );
      return section;
    }

    heading.appendChild(make('span', 'section-count', countLabel(split.here.length, 'issue') + ' total'));
    section.appendChild(heading);

    if (!split.here.length) {
      section.appendChild(make('p', 'empty', 'No accessibility findings on this screen.'));
      return section;
    }

    const scroll = make('div', 'finding-scroll');
    const list = make('ul', 'finding-list');
    const entries = keyedFindings(split.here);
    // Rows are built a page at a time.
    //
    // Not a scrolling window that recycles rows: recycling removes the row a keyboard user is
    // standing on, which drops their focus to the document, and it makes the list a screen reader
    // reads change under them. Appending on request never takes away a row somebody is using. The
    // heading above still names the true total, so bounding what is BUILT never changes what is
    // REPORTED.
    const remaining = make('p', 'more-note');
    const moreButton = make('button', 'detail-action more-button');
    moreButton.type = 'button';

    const appendPage = () => {
      const start = state.rows.length;
      const end = Math.min(start + ROW_PAGE_SIZE, entries.length);
      for (let index = start; index < end; index += 1) {
        const row = renderFindingRow(entries[index], index, payload.workspaceRoot, entries.length);
        state.rows.push(row);
        list.appendChild(row.item);
      }
      const left = entries.length - state.rows.length;
      if (left <= 0) {
        moreButton.hidden = true;
        remaining.textContent = 'Showing all ' + countLabel(entries.length, 'finding') + '.';
        return;
      }
      moreButton.hidden = false;
      moreButton.textContent = 'Show ' + Math.min(ROW_PAGE_SIZE, left) + ' more';
      remaining.textContent =
        'Showing ' + state.rows.length + ' of ' + entries.length + ' findings on this screen.';
    };

    moreButton.addEventListener('click', () => {
      // The index where this page begins, captured before appendPage grows state.rows. The first row
      // of the new page lives here.
      const firstNewIndex = state.rows.length;
      appendPage();
      applyRowState();
      // Focus stays on the control the user pressed while more rows exist. When the last page lands
      // the control disappears, so focus moves to the FIRST row that was just added, not the last.
      // Focusing the last row would let a forward Tab skip past every row between the old end and it,
      // which is exactly the rows a keyboard user just asked to see.
      if (moreButton.hidden) {
        const firstNew = state.rows[firstNewIndex];
        if (firstNew) {
          firstNew.button.focus();
        }
      }
    });

    appendPage();
    scroll.appendChild(list);
    section.appendChild(scroll);
    if (entries.length > ROW_PAGE_SIZE) {
      section.appendChild(remaining);
      section.appendChild(moreButton);
    }
    return section;
  }

  // The lead sentence of the elsewhere guide depends on whether there is anything to do here first.
  // "Fix this screen first" on a screen with nothing to fix sent developers looking for findings
  // that did not exist, so a clean or unchecked screen points at the worst screen instead.
  function elsewhereLead(split) {
    if (split.here.length > 0) {
      return 'Fix this screen first, then move on. These screens also have findings.';
    }
    if (!split.matched || split.gap) {
      return 'usabl did not check this screen. Start with the screen that has the worst findings.';
    }
    return 'Nothing was found on this screen. Start with the screen that has the worst findings.';
  }

  // The elsewhere guide: one entry per other scanned screen that has findings, worst screen first,
  // with a count and a real navigating link. It never lists the findings of other screens. The
  // intent is fix this screen, then go there, or go straight there when this screen has nothing.
  function renderElsewhere(split) {
    if (!split.elsewhere.length) {
      return null;
    }
    const section = make('section', 'section elsewhere');
    const heading = make('div', 'section-heading');
    heading.appendChild(make('h3', '', 'On other screens'));
    heading.appendChild(make('span', 'section-count', countLabel(split.elsewhereTotal, 'issue')));
    section.appendChild(heading);
    section.appendChild(make('p', 'elsewhere-lead', elsewhereLead(split)));

    const list = make('ul', 'elsewhere-list');
    for (const entry of split.elsewhere) {
      const item = make('li', 'elsewhere-item');
      const info = make('div', 'elsewhere-info');
      info.appendChild(make('span', 'elsewhere-name', entry.screenId));
      info.appendChild(make('span', 'elsewhere-count', countLabel(entry.count, 'finding')));
      // Naming the worst severity explains the order of this list rather than leaving it a mystery.
      info.appendChild(make('span', 'elsewhere-worst', 'worst: ' + entry.worstSeverity));
      if (entry.path) {
        info.appendChild(make('span', 'elsewhere-path', entry.path));
      }
      item.appendChild(info);

      // A real anchor with an href set to the screen's pathname. Clicking navigates the browser,
      // which works for a full page load and, because it is a real in-page anchor, is also fine for
      // a single-page app that intercepts same-origin link clicks. A path that will not resolve to
      // this origin gets no link at all: the path is still shown as text, so the developer can go
      // there themselves, but the overlay never hands them an off-site link.
      const href = sameOriginHref(entry.path);
      if (href !== null) {
        const link = make('a', 'elsewhere-link', 'Go to this screen');
        link.href = href;
        item.appendChild(link);
      } else if (entry.path) {
        item.appendChild(
          make('span', 'elsewhere-nolink', 'No link: that path does not resolve to this site.'),
        );
      }
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }

  function appendTokenList(parent, values, className) {
    const list = make('ul', className === 'screen-token' ? 'screen-list' : 'path-list');
    if (!values.length) {
      list.appendChild(make('li', className, 'None'));
    } else {
      for (const value of values) {
        list.appendChild(make('li', className, value));
      }
    }
    parent.appendChild(list);
  }

  function appendDefinition(list, term, value) {
    list.appendChild(make('dt', '', term));
    const definition = make('dd');
    if (Array.isArray(value)) {
      appendTokenList(
        definition,
        value,
        term === 'Affected screens' || term === 'Checked screens' ? 'screen-token' : 'path-token',
      );
    } else {
      definition.textContent = displayText(value);
    }
    list.appendChild(definition);
  }

  function renderCoverage(payload) {
    const section = make('footer', 'section coverage-footer');
    const heading = make('div', 'section-heading');
    heading.appendChild(make('h3', '', 'Coverage'));
    heading.appendChild(
      make('span', 'section-count', countLabel(payload.coverage.affected.length, 'screen') + ' affected'),
    );
    section.appendChild(heading);

    const list = make('dl', 'coverage-list');
    appendDefinition(list, 'Affected screens', payload.coverage.affected.map((screen) => screen.screenId));
    appendDefinition(list, 'Unresolved files', payload.coverage.unresolvedFiles);
    list.appendChild(make('dt', '', 'Coverage gaps'));
    const gaps = make('dd');
    const gapList = make('ul', 'gap-list');
    if (!payload.coverage.gaps.length) {
      gapList.appendChild(make('li', 'path-token', 'None'));
    } else {
      for (const gap of payload.coverage.gaps) {
        gapList.appendChild(make('li', 'gap-item', gap.ref + ': ' + gap.reason));
      }
    }
    gaps.appendChild(gapList);
    list.appendChild(gaps);
    section.appendChild(list);
    return section;
  }

  function renderReceipt(receipt) {
    if (!receipt) {
      return null;
    }
    const section = make('section', 'section receipt');
    section.appendChild(make('h3', '', 'Verified receipt'));
    const grid = make('dl', 'receipt-grid');
    appendDefinition(grid, 'Source tree', receipt.sourceTree.slice(0, 8));
    appendDefinition(grid, 'Policy', receipt.policyHash.slice(0, 8));
    appendDefinition(grid, 'Runner', receipt.runnerVersion);
    appendDefinition(grid, 'Checked screens', receipt.checkedScreens);
    appendDefinition(grid, 'Not covered', receipt.notCovered);
    appendDefinition(grid, 'Active waivers', String(receipt.activeWaivers));
    section.appendChild(grid);
    return section;
  }

  function renderGuardedPaths(paths) {
    if (!paths || !paths.length) {
      return null;
    }
    const section = make('section', 'section');
    section.appendChild(make('h3', '', 'Guarded paths awaiting review'));
    const list = make('div');
    appendTokenList(list, paths, 'path-token');
    section.appendChild(list);
    return section;
  }

  function renderFloorPaidDown(count) {
    if (!count) {
      return null;
    }
    const section = make('section', 'section');
    section.appendChild(make('h3', '', 'Floor debt resolved'));
    section.appendChild(
      make(
        'p',
        'notice',
        count + ' previously accepted ' + (count === 1 ? 'finding' : 'findings')
          + ' no longer present on cleanly scanned screens. Run usabl floor prune to remove them and re-arm the gate.',
      ),
    );
    return section;
  }

  function renderHeader(host, payload, split) {
    const header = host.shadowRoot.querySelector('.panel-header');
    const verdict = verdictFor(payload, state.error, state.scanning);

    const bar = make('div', 'panel-bar');
    const title = make('h2', '', 'usabl accessibility inspector');
    title.id = TITLE_ID;
    bar.appendChild(title);

    const controls = make('div', 'panel-controls');

    // The user-driven way to re-read the published result. This is the path that replaced the
    // window-level refresh event: a control a developer presses, not something any script on the
    // page can fire. It re-reads what usabl published; it cannot make usabl decide anything.
    const recheck = make('button', 'icon-button recheck-button', 'Check again');
    recheck.type = 'button';
    recheck.disabled = state.scanning;
    recheck.addEventListener('click', () => {
      // requestRefresh renders the scanning state synchronously, which rebuilds the header and
      // replaces this very button. The rebuilt recheck button is disabled while a scan runs, so it
      // cannot hold focus, and leaving focus where it was drops it to the document. Move focus
      // deliberately to the panel, a stable region that is always present, so a keyboard user keeps
      // their place and the next Tab starts from a known point.
      //
      // fresh: the server re-runs the engine even though it holds a cached result. This is a real
      // check of the live application, so "Scanning" is true while it runs.
      requestRefresh({ fresh: true, scanning: true });
      const panel = host.shadowRoot.querySelector('.panel');
      if (panel && !panel.hidden) {
        panel.focus();
      }
    });
    controls.appendChild(recheck);

    const widthToggle = make('button', 'icon-button width-toggle', 'Wide');
    widthToggle.type = 'button';
    widthToggle.setAttribute('aria-pressed', String(state.wide));
    widthToggle.setAttribute('aria-label', 'Wide panel');
    widthToggle.addEventListener('click', () => setWide(host, !state.wide));
    controls.appendChild(widthToggle);

    // Move the panel to the next corner. The visible label is a word, so the control never depends on
    // an icon alone, and the accessible name states where the panel is now so a screen reader user
    // knows the result of pressing it.
    const dockToggle = make('button', 'icon-button dock-toggle', 'Move');
    dockToggle.type = 'button';
    dockToggle.setAttribute('aria-label', 'Move panel. Now at ' + DOCK_LABELS[normalizeDock(state.dock)] + '.');
    dockToggle.addEventListener('click', () => {
      const index = DOCK_CORNERS.indexOf(normalizeDock(state.dock));
      const next = DOCK_CORNERS[(index + 1) % DOCK_CORNERS.length];
      setDock(host, next);
    });
    controls.appendChild(dockToggle);

    const collapse = make('button', 'icon-button collapse-button');
    collapse.type = 'button';
    collapse.setAttribute('aria-label', 'Collapse the usabl inspector');
    const collapseGlyph = make('span', '', '▼');
    collapseGlyph.setAttribute('aria-hidden', 'true');
    collapse.appendChild(collapseGlyph);
    collapse.addEventListener('click', () => setOpen(host, false, true));
    controls.appendChild(collapse);
    bar.appendChild(controls);

    // Verdict banner: symbol, then the verdict WORD, then the exit code the gate would use. The
    // word is the meaning; the colour behind it only repeats what the word already said.
    const banner = make('div', 'banner');
    banner.dataset.state = verdict.key;
    const chip = make('span', 'banner-verdict');
    const symbol = make('span', '', verdict.symbol);
    symbol.setAttribute('aria-hidden', 'true');
    chip.appendChild(symbol);
    chip.appendChild(document.createTextNode(verdict.word));
    banner.appendChild(chip);
    if (!state.scanning && !state.error && payload && typeof payload.exitCode === 'number') {
      banner.appendChild(make('span', 'banner-exit', 'exit code ' + payload.exitCode));
    }

    // One paragraph per line. Most states are one sentence; approval is several facts, and each
    // gets its own paragraph so a screen reader pauses between them and a sighted reader can scan.
    const noteLines = explanationFor(payload, state.error, state.scanning, split);
    const notes = noteLines.map((line) => make('p', 'banner-note', line));

    const screenLine = make('div', 'screen-line');
    screenLine.appendChild(make('span', 'screen-label', 'This screen'));
    screenLine.appendChild(make('span', 'screen-path', split.currentPath));
    // Counts are only shown once a result is loaded. Printing "0 here" while the first scan is still
    // running would state a fact usabl does not have yet.
    if (payload && payload.loaded && !state.error) {
      screenLine.appendChild(
        make(
          'span',
          'screen-counts',
          split.here.length + ' here · ' + split.elsewhereTotal + ' on other screens',
        ),
      );
    }

    // On an idle run the screen split is all zeros, so it only repeats "nothing". The banner and the
    // note already say there was nothing to check, so the line is dropped in that state. A run with
    // no verdict drops it too: "0 here" is not a count usabl stands behind when it proved nothing.
    const oneStatement = verdict.key === 'idle' || verdict.key === 'no-verdict';
    const headerChildren = oneStatement ? [bar, banner, ...notes] : [bar, banner, ...notes, screenLine];
    header.replaceChildren(...headerChildren);
    announceVerdict(verdict, split, payload);
  }

  // One short sentence per real state change, written to the hidden live region.
  //
  // Without this a screen reader user watching a fix loop hears nothing at all: the banner goes from
  // regression to verified in silence. It is deliberately terse and it is written only when the
  // sentence differs from the last one, so a re-render on a route change does not repeat it.
  function announceVerdict(verdict, split, payload) {
    if (!state.verdictStatus) {
      return;
    }
    let sentence = 'usabl: ' + verdict.word + '.';
    if (!state.scanning && !state.error && payload && payload.loaded) {
      if (!split.matched) {
        sentence += ' This screen was not scanned.';
      } else if (split.here.length > 0) {
        sentence += ' ' + countLabel(split.here.length, 'finding') + ' on this screen.';
      } else {
        sentence += ' No findings on this screen.';
      }
    }
    if (sentence === state.lastVerdictAnnouncement) {
      return;
    }
    state.lastVerdictAnnouncement = sentence;
    state.verdictStatus.textContent = sentence;
  }

  function renderBadge(host, payload, split) {
    const badge = host.shadowRoot.querySelector('.badge');
    const view = badgeView(payload, state.error, state.scanning, split);
    badge.dataset.state = view.key;
    // The wordmark stays in the collapsed badge so it is always clear this control is usabl and not
    // a generic help button. The glyph beside it carries the state, and the accessible name already
    // says the whole thing, so the wordmark and glyph are decoration for a sighted reader.
    const word = make('span', 'badge-word', 'usabl');
    word.setAttribute('aria-hidden', 'true');
    const symbol = make('span', 'badge-symbol', view.symbol);
    symbol.setAttribute('aria-hidden', 'true');
    const children = [word, symbol];
    if (view.count !== null) {
      children.push(make('span', 'badge-count', String(view.count)));
    }
    badge.replaceChildren(...children);
    // The accessible name carries the whole state, because the glyph and the number alone do not
    // say what they are counting.
    badge.setAttribute('aria-label', view.label);
  }

  // Shown whenever the page had already replaced a global the overlay reads results through. It is
  // not a claim that anything was tampered with. It is a plain statement that usabl cannot tell.
  function renderTamperNotice() {
    if (!globalsReplaced) {
      return null;
    }
    const section = make('section', 'section tamper-notice');
    section.appendChild(make('h3', '', 'This view may not be the real result'));
    section.appendChild(
      make(
        'p',
        'notice',
        'Something on this page replaced the browser functions usabl reads its result through, '
          + 'before usabl loaded. usabl cannot tell whether what you see below came from the engine. '
          + 'Run usabl check in a terminal to see the result the gate uses.',
      ),
    );
    return section;
  }

  function renderBody(host, payload, split) {
    const body = host.shadowRoot.querySelector('.panel-body');
    const tamper = renderTamperNotice();

    if (state.error) {
      const section = make('section', 'section');
      section.appendChild(make('h3', '', 'No result to show'));
      section.appendChild(make('p', 'notice', payload.summary));
      body.replaceChildren(...(tamper ? [tamper, section] : [section]));
      return;
    }

    if (!payload.loaded) {
      const section = make('section', 'section');
      section.appendChild(make('h3', '', 'Loading result'));
      section.appendChild(make('div', 'loading-line'));
      section.appendChild(make('div', 'loading-line'));
      body.replaceChildren(...(tamper ? [tamper, section] : [section]));
      return;
    }

    // Nothing to check and nothing left uncovered. The header already states this in full, so the
    // body stays empty rather than repeating "none" as an empty issues section and a coverage table
    // of zeros. A run that was idle but still has coverage gaps falls through to the full body.
    const verdict = verdictFor(payload, state.error, state.scanning);
    const gaps = payload.coverage && Array.isArray(payload.coverage.gaps) ? payload.coverage.gaps : [];
    if (verdict.key === 'idle' && gaps.length === 0) {
      body.replaceChildren(...(tamper ? [tamper] : []));
      return;
    }

    // No verdict: the run crashed, was refused its configuration, or ended without minting one. An
    // empty issues list and a coverage table of "None" would bury the one thing the developer needs,
    // which is the engine's reason. That reason is in summary, engine-authored, and may quote a
    // config error and how to fix it. So the body is one section: the reason, then the consequence.
    if (verdict.key === 'no-verdict') {
      const section = make('section', 'section no-verdict');
      section.appendChild(make('h3', '', 'Why there is no verdict'));
      const reason = boundedText(payload.summary, MAX_PROSE_CHARS).trim();
      section.appendChild(make('p', 'notice', reason || 'usabl gave no reason.'));
      section.appendChild(make('p', 'notice', 'Nothing on this screen is proven.'));
      body.replaceChildren(...(tamper ? [tamper, section] : [section]));
      return;
    }

    // The notice goes first, above the verdict, because it changes how everything below it should
    // be read.
    const children = tamper ? [tamper] : [];
    children.push(renderCurrentScreen(payload, split));
    const elsewhere = renderElsewhere(split);
    if (elsewhere) children.push(elsewhere);
    const receipt = renderReceipt(payload.receipt);
    if (receipt) children.push(receipt);
    const guarded = renderGuardedPaths(payload.dirtyGuardedPaths);
    if (guarded) children.push(guarded);
    const floorPaidDown = renderFloorPaidDown(payload.paidDownCount);
    if (floorPaidDown) children.push(floorPaidDown);
    children.push(renderCoverage(payload));
    body.replaceChildren(...children);
  }

  // What the overlay shows before the first result arrives. loaded stays false so every surface can
  // tell "no result yet" apart from "a result that found nothing".
  const EMPTY_PAYLOAD = {
    loaded: false,
    verdict: null,
    summary: '',
    coverage: { affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
    findings: [],
    receipt: null,
    dirtyGuardedPaths: [],
    paidDownCount: 0,
  };

  // One render pass. The badge and the panel are drawn from the same split, so the number on the
  // badge and the number in the header can never disagree.
  function render(host) {
    const payload = state.payload || EMPTY_PAYLOAD;
    const split = (state.error || !state.payload)
      ? emptySplit(window.location.pathname)
      : partitionByScreen(payload, window.location.pathname, liveLocationKey());
    state.split = split;
    state.rows = [];

    renderBadge(host, payload, split);
    renderHeader(host, payload, split);
    renderBody(host, payload, split);

    // A row that no longer exists cannot stay expanded, and its highlight cannot stay on the page.
    if (state.expandedKey !== null && rowByKey(state.expandedKey) === null) {
      state.expandedKey = null;
      clearHighlight();
      clearLocateStatus();
    }
    applyRowState();
    syncOpen(host, false);
  }

  function errorPayload() {
    return {
      loaded: true,
      verdict: null,
      summary: 'The inspector could not load the current result. Check the dev server logs.',
      coverage: { affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
      findings: [],
      receipt: null,
      dirtyGuardedPaths: [],
      paidDownCount: 0,
    };
  }

  // A re-scan keeps the last result on screen and marks the panel as scanning. Wiping the panel back
  // to a skeleton on every save would make the fix loop flicker, and there is nothing dishonest
  // about showing the previous result while plainly saying a new scan is running.
  function renderScanning(host) {
    state.error = false;
    state.scanning = true;
    clearHighlight();
    if (host) {
      render(host);
    }
  }

  function renderPayload(payload, error) {
    const host = ensureInspector();
    // The page may have been re-rendered under us, so the old outline can point at a node that is
    // no longer there. Drop it and re-anchor below if the row it belonged to survived.
    clearHighlight();
    if (!host) {
      return;
    }
    state.payload = Object.assign({ loaded: true }, payload);
    state.error = error === true;
    state.scanning = false;
    render(host);
    if (state.open && state.expandedKey !== null) {
      const row = rowByKey(state.expandedKey);
      if (row) {
        highlightFinding(row.finding, row.key);
      }
    }
  }

  // Re-partition the current-screen and elsewhere split after an in-app route change.
  //
  // A single-page app changes route without a full reload, so the overlay must re-render or it keeps
  // showing the previous screen's findings. Any expanded row and any highlight belonged to the
  // screen we just left, so both are dropped.
  function handleRouteChange() {
    if (state.scanning || state.error || !state.payload) {
      return;
    }
    const host = state.host;
    if (!host || !host.isConnected || !host.shadowRoot) {
      return;
    }
    clearHighlight();
    clearLocateStatus();
    state.expandedKey = null;
    render(host);
  }

  // Wrap history.pushState and history.replaceState so client-side navigation emits an event we can
  // listen for. The History API does not fire an event on these calls, unlike popstate for the back
  // and forward buttons, so a router that only pushes state would otherwise leave the overlay stale.
  // We wrap once, keep the original behavior, and dispatch a synthetic event the overlay listens to.
  function hookNavigation() {
    if (state.navHooked) {
      return;
    }
    state.navHooked = true;
    const emit = () => window.dispatchEvent(new Event('usabl:locationchange'));
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      if (typeof original !== 'function') {
        continue;
      }
      history[name] = function () {
        const result = original.apply(this, arguments);
        emit();
        return result;
      };
    }
    window.addEventListener('popstate', handleRouteChange);
    window.addEventListener('hashchange', handleRouteChange);
    window.addEventListener('usabl:locationchange', handleRouteChange);
  }

  // Two refreshes can be in flight at once around a save, because the dev server drops its cached
  // result on a file change while an older run is still finishing. Responses can then land out of
  // order and an older verified result can overwrite a newer regression, leaving the panel green
  // while the engine says blocked. Every request takes a generation number and any response that is
  // not from the newest request is dropped on the floor.
  let refreshGeneration = 0;
  let refreshRunning = false;
  let refreshQueued = false;
  // What the waiting refresh, if any, has been asked for. A burst merges into one read, and that
  // read is fresh if any request in the burst was, and shows scanning if any request in it does.
  let queuedFresh = false;
  let queuedScanning = false;

  // The three reasons the client reads the result, and what each one honestly knows.
  //
  // The dev server caches the last completed result and only re-runs the engine after a file change
  // or when asked outright. So a read does not always mean a scan, and the badge must not say
  // "Scanning" when nothing is running.
  //
  // - On page load the client cannot know whether the server has a cached result or is about to
  //   scan, so it keeps the "No result yet" state, which is true either way.
  // - A refresh pushed by the dev server follows an invalidation, so the read it triggers does run
  //   the engine, and "Scanning" is true.
  // - "Check again" sends fresh=1, which makes the server run the engine even with a cached result.
  //   That is the one user-driven re-run. It is a real check, not a cache read, because the scan
  //   measures the live application, which can change without a source edit. "Scanning" is true.
  async function performRefresh(options) {
    const host = ensureInspector();
    if (!host) {
      // ensureInspector already said, once and loudly, why there is no inspector. Reading the result
      // to render it into nothing would only burn requests.
      return;
    }
    // The generation was already advanced by requestRefresh the moment this run's intent arrived, so
    // any earlier in-flight response is already superseded. Read the current generation and hold any
    // rendering to it, so a later refresh landing while this run is mid-fetch supersedes this one too.
    const generation = refreshGeneration;
    const isCurrent = () => generation === refreshGeneration;
    if (options.scanning) {
      renderScanning(host);
    } else if (!state.payload) {
      // First read, nothing to claim yet. Draw the "No result yet" state so the panel is not empty
      // while the response is on its way.
      render(host);
    }
    const url = options.fresh ? RESULT_ENDPOINT + '?fresh=1' : RESULT_ENDPOINT;
    try {
      const response = await nativeFetch(url, { cache: 'no-store' });
      if (!isCurrent()) {
        return;
      }
      if (!response.ok) {
        throw new Error('status ' + response.status);
      }
      const payload = await nativeResponseJson.call(response);
      if (!isCurrent()) {
        return;
      }
      renderPayload(payload, false);
    } catch (_err) {
      if (!isCurrent()) {
        return;
      }
      renderPayload(errorPayload(), true);
    }
  }

  // At most one request in flight and at most one waiting. A burst of saves or watcher events
  // collapses into one more read rather than one read per event.
  //
  // Advancing the generation here, the instant refresh intent arrives, is what makes a superseded
  // response harmless. If we only advanced it when the queued run finally started, an in-flight
  // response could still pass isCurrent() and render an older result over a newer one. By bumping the
  // counter now, any response from the run already in flight fails isCurrent() and is dropped, so an
  // old verified result can never overwrite a newer regression.
  function requestRefresh(options) {
    const fresh = options && options.fresh === true;
    const scanning = options && options.scanning === true;
    refreshGeneration += 1;
    if (refreshRunning) {
      refreshQueued = true;
      queuedFresh = queuedFresh || fresh;
      queuedScanning = queuedScanning || scanning;
      return;
    }
    runQueuedRefresh({ fresh, scanning });
  }

  async function runQueuedRefresh(options) {
    refreshRunning = true;
    try {
      await performRefresh(options);
    } finally {
      refreshRunning = false;
      if (refreshQueued) {
        refreshQueued = false;
        const next = { fresh: queuedFresh, scanning: queuedScanning };
        queuedFresh = false;
        queuedScanning = false;
        runQueuedRefresh(next);
      }
    }
  }

  hookNavigation();
  // Page load: the server may answer from its cache in milliseconds or scan for many seconds, and
  // the client cannot tell which, so it shows "No result yet" rather than claiming a scan.
  requestRefresh({ fresh: false, scanning: false });
  // The dev server pushes a refresh over its own hot channel after a file change has invalidated
  // its cached result, so the read this triggers runs the engine. There is deliberately no
  // window-level event for this: any script on the page can dispatch a window event, and a refresh
  // the page can trigger is a lever the page can use to time what the developer sees. The "Check
  // again" control in the panel is the user-driven path.
  if (import.meta && import.meta.hot && typeof import.meta.hot.on === 'function') {
    import.meta.hot.on('usabl:refresh', () => {
      requestRefresh({ fresh: false, scanning: true });
    });
  }
})();`;
