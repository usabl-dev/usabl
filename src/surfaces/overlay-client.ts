/**
 * Browser client source for the advisory accessibility inspector.
 * This unit renders read-only status from server projections.
 * It must never influence gate outcomes or trust page text as HTML.
 */
import { UNTRUSTED_FRAME_END, UNTRUSTED_FRAME_START } from './scrub.js';

export const overlayClientSource = `(() => {
  const RESULT_ENDPOINT = '/__usabl/result';
  const HOST_ID = '__usabl-overlay';
  const PANEL_ID = '__usabl-inspector-panel';
  // Interpolated from the one definition in scrub.ts. This client unwraps a framed value by
  // matching these exact strings, so a second copy here would stop unwrapping the moment the
  // marker wording changed, and would show a user raw markers instead of the page text.
  const UNTRUSTED_START = ${JSON.stringify(UNTRUSTED_FRAME_START)};
  const UNTRUSTED_END = ${JSON.stringify(UNTRUSTED_FRAME_END)};

  const state = {
    expanded: false,
    payload: null,
    error: false,
    scanning: false,
    highlightCleanup: null,
    navHooked: false,
  };

  function displayText(value) {
    if (typeof value !== 'string') {
      return '';
    }
    if (value.startsWith(UNTRUSTED_START) && value.endsWith(UNTRUSTED_END)) {
      return value.slice(UNTRUSTED_START.length, -UNTRUSTED_END.length).trim();
    }
    return value;
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

  // Split findings into the screen the browser is on and every other scanned screen.
  //
  // The overlay is screen-aware: it guides the developer one screen at a time. It matches the live
  // pathname to a scanned screen through coverage.affected, then partitions findings by screenId.
  // "here" is a flat list of this screen's findings, each individually locatable. "elsewhere" is a
  // per-screen count plus a path to navigate to, and never the other screens' individual findings.
  function partitionByScreen(payload, currentPath) {
    const affected = (payload && payload.coverage && Array.isArray(payload.coverage.affected))
      ? payload.coverage.affected
      : [];
    const findings = Array.isArray(payload.findings) ? payload.findings : [];
    const normalizedCurrent = normalizePath(currentPath);

    // Map each affected screenId to its normalized pathname, and find which one is current.
    let currentScreenId = null;
    const screenPath = new Map();
    for (const screen of affected) {
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
      } else {
        const entry = elsewhereCounts.get(finding.screenId) || { screenId: finding.screenId, count: 0 };
        entry.count += 1;
        elsewhereCounts.set(finding.screenId, entry);
      }
    }

    const elsewhere = [];
    for (const entry of elsewhereCounts.values()) {
      // Prefer the scan-time pathname for this screen when we have one, so the navigating link is a
      // real route. When a finding names a screen that is not in coverage.affected, we have no path
      // and omit the link rather than guess a route that may not exist.
      const path = screenPath.get(entry.screenId) || null;
      elsewhere.push({ screenId: entry.screenId, count: entry.count, path });
    }
    elsewhere.sort((a, b) => a.screenId.localeCompare(b.screenId));

    return { matched: currentScreenId !== null, currentScreenId, here, elsewhere };
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

  function statusFor(payload, error, scanning) {
    if (scanning) return { key: 'scanning', label: 'Scanning', symbol: '…' };
    if (error) return { key: 'error', label: 'NOT verified', symbol: '!' };
    if (payload.verdict === 'verified') return { key: 'verified', label: 'Verified', symbol: '✓' };
    if (payload.verdict === 'regression') return { key: 'regression', label: 'Regression', symbol: '×' };
    if (payload.verdict === 'not_covered') return { key: 'not-covered', label: 'Not covered', symbol: '?' };
    if (payload.verdict === 'approval_required') return { key: 'approval', label: 'Approval required', symbol: '!' };
    return { key: 'idle', label: 'Idle', symbol: '○' };
  }

  function ensureInspector() {
    let host = document.getElementById(HOST_ID);
    if (host) {
      return host;
    }

    host = document.createElement('aside');
    host.id = HOST_ID;
    host.setAttribute('aria-label', 'usabl development tools');
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('right', '12px', 'important');
    host.style.setProperty('bottom', '12px', 'important');
    host.style.setProperty('width', 'min(430px, calc(100vw - 24px))', 'important');
    host.style.setProperty('max-height', 'calc(100vh - 24px)', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = \`
      :host {
        color-scheme: light;
        --ink: #101827;
        --ink-surface: #172033;
        --paper: #f7f5ef;
        --white: #ffffff;
        --cobalt: #2457e6;
        --cobalt-light: #dfe7ff;
        --green: #177a4a;
        --green-light: #e6f4ed;
        --red: #c9363e;
        --red-light: #fbeaec;
        --amber: #a95f00;
        --amber-light: #fff1d7;
        --violet: #7452b8;
        --violet-light: #f0eafa;
        --slate: #596579;
        --rule: #cbd2de;
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

      .shell {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
        width: 100%;
        max-height: calc(100vh - 24px);
        color: var(--ink);
      }

      .launcher {
        align-self: flex-end;
        display: flex;
        align-items: center;
        gap: 9px;
        min-height: 44px;
        max-width: 100%;
        padding: 9px 12px;
        border: 1px solid var(--ink);
        border-radius: 10px;
        background: var(--ink);
        color: var(--white);
        cursor: pointer;
        box-shadow: 0 4px 8px rgba(16, 24, 39, 0.24);
        transition: background-color 180ms ease-out, transform 180ms ease-out;
      }

      .launcher:hover {
        background: var(--ink-surface);
      }

      .launcher:active {
        transform: translateY(1px);
      }

      .launcher:focus-visible,
      .finding-button:focus-visible,
      .elsewhere-link:focus-visible,
      .editor-link:focus-visible {
        outline: 3px solid var(--cobalt);
        outline-offset: 3px;
      }

      .launcher[data-expanded="true"] {
        width: 100%;
        justify-content: flex-start;
        border-color: var(--ink-surface);
        border-radius: 10px 10px 4px 4px;
      }

      .brand {
        font-weight: 760;
        letter-spacing: -0.02em;
      }

      .launcher-status {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 0.875rem;
      }

      .launcher-count {
        margin-left: auto;
        color: #dce3ef;
        font-size: 0.8125rem;
        white-space: nowrap;
      }

      .panel {
        width: 100%;
        max-height: calc(100vh - 84px);
        overflow: auto;
        overscroll-behavior: contain;
        border: 1px solid var(--ink-surface);
        border-radius: 4px 4px 12px 12px;
        background: var(--paper);
        color: var(--ink);
        box-shadow: 0 4px 8px rgba(16, 24, 39, 0.2);
      }

      .panel[hidden] {
        display: none;
      }

      .panel-header {
        padding: 16px 18px 14px;
        background: var(--ink);
        color: var(--white);
      }

      .panel-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      h2, h3, h4, p, dl, dd {
        margin: 0;
      }

      h2 {
        font-size: 1.125rem;
        line-height: 1.25;
        letter-spacing: -0.02em;
        text-wrap: balance;
      }

      h3 {
        font-size: 0.9375rem;
        line-height: 1.35;
      }

      h4 {
        font-size: 0.875rem;
        line-height: 1.4;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 26px;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 700;
        white-space: nowrap;
      }

      .status[data-status="verified"] { background: var(--green-light); color: #0f5a36; }
      .status[data-status="regression"],
      .status[data-status="error"] { background: var(--red-light); color: #9f252d; }
      .status[data-status="not-covered"] { background: var(--amber-light); color: #754200; }
      .status[data-status="approval"] { background: var(--violet-light); color: #54388c; }
      .status[data-status="scanning"] { background: var(--cobalt-light); color: #173d9f; }
      .status[data-status="idle"] { background: #e8ebf0; color: #3d485a; }

      .summary {
        margin-top: 8px;
        max-width: 68ch;
        color: #dce3ef;
        font-size: 0.875rem;
        overflow-wrap: anywhere;
        text-wrap: pretty;
      }

      .advisory {
        margin-top: 8px;
        color: #b9c3d3;
        font-size: 0.75rem;
      }

      .section {
        padding: 15px 18px;
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

      .section-count {
        color: var(--slate);
        font-size: 0.75rem;
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
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .screen-token,
      .path-token {
        display: inline-flex;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--cobalt-light);
        color: #173d9f;
        font-size: 0.75rem;
        font-weight: 650;
      }

      .path-token {
        background: #e8ebf0;
        color: #3d485a;
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

      .finding-list {
        display: grid;
        gap: 6px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .finding-item {
        display: grid;
        gap: 4px;
      }

      .finding-button {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 3px 10px;
        width: 100%;
        padding: 10px 11px;
        border: 1px solid var(--rule);
        border-radius: 8px;
        background: var(--white);
        color: var(--ink);
        text-align: left;
        cursor: pointer;
        transition: border-color 150ms ease-out, background-color 150ms ease-out;
      }

      .finding-button:hover {
        border-color: var(--cobalt);
        background: #f6f8ff;
      }

      .finding-button:active {
        transform: translateY(1px);
      }

      .finding-symbol {
        grid-row: 1 / span 1;
        align-self: start;
        color: var(--red);
        font-weight: 800;
      }

      .finding-button[data-status="fixed"] .finding-symbol,
      .finding-button[data-status="waived"] .finding-symbol {
        color: var(--green);
      }

      .finding-body {
        display: grid;
        gap: 3px;
        min-width: 0;
      }

      .finding-label {
        font-size: 0.875rem;
        font-weight: 680;
        line-height: 1.4;
        overflow-wrap: anywhere;
        text-wrap: pretty;
      }

      .finding-fix {
        color: #344054;
        font-size: 0.8125rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
        text-wrap: pretty;
      }

      .finding-support {
        color: var(--slate);
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.6875rem;
        overflow-wrap: anywhere;
      }

      .finding-affordance {
        margin-top: 3px;
        color: #1745bd;
        font-size: 0.75rem;
        font-weight: 700;
      }

      .finding-affordance::before {
        content: "→";
        margin-right: 5px;
      }

      .editor-link {
        display: inline-flex;
        align-items: center;
        margin-left: 34px;
        color: #1745bd;
        font-size: 0.75rem;
        font-weight: 700;
        text-decoration: none;
      }

      .editor-link:hover {
        text-decoration: underline;
      }

      .locate-status {
        margin-left: 34px;
        color: var(--slate);
        font-size: 0.75rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .locate-status:empty {
        display: none;
      }

      .locate-selector {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.6875rem;
        color: var(--ink);
      }

      .current-screen-name {
        margin-bottom: 10px;
        color: var(--slate);
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.75rem;
        overflow-wrap: anywhere;
      }

      .elsewhere-lead {
        margin-bottom: 10px;
        color: #344054;
        font-size: 0.8125rem;
        line-height: 1.4;
        text-wrap: pretty;
      }

      .elsewhere-list {
        display: grid;
        gap: 6px;
        margin: 0;
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
        color: #9f252d;
        font-size: 0.6875rem;
        font-weight: 700;
      }

      .elsewhere-path {
        width: 100%;
        color: var(--slate);
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.6875rem;
        overflow-wrap: anywhere;
      }

      .elsewhere-link {
        min-height: 36px;
        display: inline-flex;
        align-items: center;
        padding: 6px 11px;
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
      }

      .empty {
        color: var(--slate);
        font-size: 0.8125rem;
      }

      .receipt {
        background: var(--green-light);
      }

      .receipt h3 {
        color: #0f5a36;
      }

      .receipt-grid {
        margin-top: 10px;
      }

      .loading-line {
        height: 10px;
        margin-top: 8px;
        border-radius: 4px;
        background: #dce1e9;
      }

      .loading-line:nth-child(2) {
        width: 72%;
      }

      @media (max-width: 520px) {
        :host {
          font-size: 15px;
        }

        .panel {
          max-height: calc(100vh - 76px);
        }

        .panel-header,
        .section {
          padding-left: 14px;
          padding-right: 14px;
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

    const shell = make('div', 'shell');
    const launcher = make('button', 'launcher');
    launcher.type = 'button';
    launcher.setAttribute('aria-controls', PANEL_ID);
    launcher.setAttribute('aria-expanded', 'false');
    const panel = make('section', 'panel');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'usabl accessibility inspector');
    panel.hidden = true;

    launcher.addEventListener('click', () => {
      state.expanded = !state.expanded;
      syncExpansion(host);
    });

    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.expanded) {
        event.preventDefault();
        state.expanded = false;
        syncExpansion(host);
        launcher.focus();
      }
    });

    shell.appendChild(launcher);
    shell.appendChild(panel);
    shadow.appendChild(style);
    shadow.appendChild(shell);
    document.body.appendChild(host);
    renderLoading(host);
    return host;
  }

  function findingsCount(payload) {
    if (typeof payload.findingsTotalCount === 'number') {
      return payload.findingsTotalCount;
    }
    return Array.isArray(payload.findings) ? payload.findings.length : 0;
  }

  function syncExpansion(host) {
    const shadow = host.shadowRoot;
    const launcher = shadow.querySelector('.launcher');
    const panel = shadow.querySelector('.panel');
    const payload = state.payload;
    const status = statusFor(payload || { verdict: null }, state.error, state.scanning);
    const count = findingsCount(payload || {});
    const countLabel = count === 1 ? '1 finding' : count + ' findings';

    launcher.dataset.expanded = String(state.expanded);
    launcher.setAttribute('aria-expanded', String(state.expanded));
    launcher.setAttribute(
      'aria-label',
      state.expanded
        ? 'Close usabl inspector'
        : 'Open usabl inspector. ' + status.label + '. ' + countLabel + '.',
    );
    panel.hidden = !state.expanded;
    if (!state.expanded) {
      clearHighlight();
    }
  }

  function clearHighlight() {
    if (typeof state.highlightCleanup === 'function') {
      state.highlightCleanup();
      state.highlightCleanup = null;
    }
    const stale = document.getElementById('__usabl-highlight');
    if (stale) stale.remove();
    // Remove any tabindex we added only to focus a non-focusable flagged element, so the page's own
    // tab order is left exactly as it was before we located anything.
    const temped = document.querySelectorAll('[data-usabl-temp-tabindex="true"]');
    temped.forEach((node) => {
      node.removeAttribute('tabindex');
      delete node.dataset.usablTempTabindex;
    });
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

  function locateFinding(finding, statusHost) {
    clearHighlight();
    const selector = displayText(finding.elementPath).trim();
    let target = null;
    try {
      target = selector ? document.querySelector(selector) : null;
    } catch (_error) {
      target = null;
    }

    const inspector = document.getElementById(HOST_ID);
    if (!target || target === inspector || (inspector && inspector.contains(target))) {
      // Honest status: the finding was true at scan time; the DOM has changed since. We name the
      // selector so a developer can see what was flagged and where it was.
      statusHost.replaceChildren();
      statusHost.appendChild(
        document.createTextNode('This was flagged here at the last scan; it is not on the page right now.'),
      );
      if (selector) {
        const code = document.createElement('code');
        code.className = 'locate-selector';
        code.textContent = selector;
        statusHost.appendChild(document.createTextNode(' '));
        statusHost.appendChild(code);
      }
      return;
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });

    const marker = document.createElement('div');
    marker.id = '__usabl-highlight';
    marker.setAttribute('aria-hidden', 'true');
    const targetName = displayText(finding.elementName) || selector || 'selected element';
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
    const timeout = window.setTimeout(clearHighlight, 5000);
    state.highlightCleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
      marker.remove();
    };

    // Move keyboard focus to the flagged element so a keyboard user lands on it, not just a sighted
    // one. Some flagged elements are not focusable by default; a temporary tabindex of -1 lets us
    // focus them programmatically without adding them to the tab order. preventScroll keeps our own
    // centered scrollIntoView from being overridden by the browser's focus scroll.
    try {
      if (!target.hasAttribute('tabindex')) {
        target.setAttribute('tabindex', '-1');
        target.dataset.usablTempTabindex = 'true';
      }
      target.focus({ preventScroll: true });
    } catch (_error) {
      // Focus can throw on detached or disabled nodes. The highlight still stands on its own.
    }

    statusHost.textContent = 'Highlighted ' + targetName + ' on the page.';
  }

  function renderLauncher(host, payload, error) {
    const launcher = host.shadowRoot.querySelector('.launcher');
    const status = statusFor(payload, error, state.scanning);
    const count = findingsCount(payload);
    const countLabel = count === 1 ? '1 finding' : count + ' findings';
    const brand = make('span', 'brand', 'usabl');
    const statusText = make('span', 'launcher-status');
    const symbol = make('span', '', status.symbol);
    symbol.setAttribute('aria-hidden', 'true');
    statusText.appendChild(symbol);
    statusText.appendChild(document.createTextNode(status.label));
    const countText = make('span', 'launcher-count', countLabel);

    launcher.replaceChildren(brand, statusText, countText);
    syncExpansion(host);
  }

  function appendStatus(parent, status) {
    const badge = make('span', 'status');
    badge.dataset.status = status.key;
    const symbol = make('span', '', status.symbol);
    symbol.setAttribute('aria-hidden', 'true');
    badge.appendChild(symbol);
    badge.appendChild(document.createTextNode(status.label));
    parent.appendChild(badge);
  }

  function appendTokenList(parent, values, className) {
    const list = make('ul', className === 'screen-token' ? 'screen-list' : 'path-list');
    if (!values.length) {
      const item = make('li', className, 'None');
      list.appendChild(item);
    } else {
      for (const value of values) {
        const item = make('li', className, value);
        list.appendChild(item);
      }
    }
    parent.appendChild(list);
  }

  function appendDefinition(list, term, value) {
    list.appendChild(make('dt', '', term));
    const definition = make('dd');
    if (Array.isArray(value)) {
      appendTokenList(definition, value, term === 'Affected screens' || term === 'Checked screens' ? 'screen-token' : 'path-token');
    } else {
      definition.textContent = displayText(value);
    }
    list.appendChild(definition);
  }

  function renderCoverage(payload) {
    const section = make('section', 'section');
    const heading = make('div', 'section-heading');
    heading.appendChild(make('h3', '', 'Coverage'));
    heading.appendChild(make('span', 'section-count', String(payload.coverage.affected.length) + ' affected'));
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

  // A finding row on the current screen. The whole row is a real button: activating it locates the
  // element on the live page, highlights it, moves focus to it, and reports an honest status. There
  // is no separate "Locate" control and no selection or detail pane, because the current-screen list
  // is flat and every row acts on click.
  function renderFindingRow(finding, workspaceRoot) {
    const item = make('li', 'finding-item');

    const button = make('button', 'finding-button');
    button.type = 'button';
    button.dataset.status = finding.status;
    // The accessible name carries the impact plus a plain "click to find it" affordance, so a
    // screen-reader user hears what the button does, not just what the finding is.
    button.setAttribute(
      'aria-label',
      displayText(finding.whatUserExperiences) + ' Activate to find this on the page.',
    );

    const symbol = make('span', 'finding-symbol', finding.status === 'fixed' || finding.status === 'waived' ? '✓' : '×');
    symbol.setAttribute('aria-hidden', 'true');
    button.appendChild(symbol);

    const body = make('div', 'finding-body');
    body.appendChild(make('span', 'finding-label', finding.whatUserExperiences));

    // A hint of the fix under the impact, so a developer sees what to do without opening anything.
    if (finding.fix) {
      body.appendChild(make('span', 'finding-fix', displayText(finding.fix)));
    }

    const supportText =
      finding.rule +
      ' · ' +
      finding.layer +
      ' · ' +
      finding.severity +
      (finding.groupCount ? ' · ×' + finding.groupCount : '');
    body.appendChild(make('span', 'finding-support', supportText));

    // The "click to find it" affordance, shown to sighted users and hidden from the accessible name
    // above so it is not read twice.
    const affordance = make('span', 'finding-affordance', 'Find on page');
    affordance.setAttribute('aria-hidden', 'true');
    body.appendChild(affordance);

    button.appendChild(body);

    // One status line per row, announced politely, that reports located or the honest not-found text.
    const locateStatus = make('p', 'locate-status');
    locateStatus.setAttribute('aria-live', 'polite');

    button.addEventListener('click', () => locateFinding(finding, locateStatus));

    item.appendChild(button);
    item.appendChild(locateStatus);

    // Editor deep link stays available per row when the source tier is a renderer file.
    const editorHref = editorDeepLink(workspaceRoot, finding.appSource);
    if (editorHref) {
      const openEditor = make('a', 'editor-link', 'Open in editor');
      openEditor.href = editorHref;
      openEditor.target = '_blank';
      openEditor.rel = 'noopener noreferrer';
      item.appendChild(openEditor);
    }

    return item;
  }

  // The current-screen section: a flat, individually clickable list of every finding on this screen,
  // or an honest message when the live path matches no scanned screen.
  function renderCurrentScreen(payload, split) {
    const section = make('section', 'section current-screen');
    const heading = make('div', 'section-heading');
    heading.appendChild(make('h3', '', 'This screen'));

    if (!split.matched) {
      section.appendChild(heading);
      section.appendChild(make('p', 'empty', 'This screen was not part of the last scan.'));
      return section;
    }

    heading.appendChild(
      make('span', 'section-count', split.here.length === 1 ? '1 finding' : split.here.length + ' findings'),
    );
    section.appendChild(heading);

    // Name the matched screen so the developer knows which route the list belongs to.
    section.appendChild(make('p', 'current-screen-name', split.currentScreenId));

    if (!split.here.length) {
      section.appendChild(make('p', 'empty', 'No accessibility findings on this screen.'));
      return section;
    }

    const list = make('ul', 'finding-list');
    for (const finding of split.here) {
      list.appendChild(renderFindingRow(finding, payload.workspaceRoot));
    }
    section.appendChild(list);
    return section;
  }

  // The elsewhere guide: one entry per other scanned screen that has findings, with a count and a
  // real navigating link. It never lists the individual findings of other screens. The intent is
  // fix here, then go there.
  function renderElsewhere(split) {
    if (!split.elsewhere.length) {
      return null;
    }
    const section = make('section', 'section elsewhere');
    const heading = make('div', 'section-heading');
    heading.appendChild(make('h3', '', 'On other screens'));
    section.appendChild(heading);
    section.appendChild(
      make('p', 'elsewhere-lead', 'Fix this screen first, then move on. These screens also have findings.'),
    );

    const list = make('ul', 'elsewhere-list');
    for (const entry of split.elsewhere) {
      const item = make('li', 'elsewhere-item');
      const info = make('div', 'elsewhere-info');
      info.appendChild(make('span', 'elsewhere-name', entry.screenId));
      const countText = entry.count === 1 ? '1 finding' : entry.count + ' findings';
      info.appendChild(make('span', 'elsewhere-count', countText));
      if (entry.path) {
        info.appendChild(make('span', 'elsewhere-path', entry.path));
      }
      item.appendChild(info);

      if (entry.path) {
        // A real anchor with an href set to the screen's pathname. Clicking navigates the browser,
        // which works for a full page load and, because it is a real in-page anchor, is also fine
        // for a single-page app that intercepts same-origin link clicks.
        const link = make('a', 'elsewhere-link', 'Go to this screen');
        link.href = entry.path;
        item.appendChild(link);
      }
      list.appendChild(item);
    }
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
    if (!paths.length) {
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
    const plural = count === 1 ? 'finding' : 'findings';
    section.appendChild(make('h3', '', 'Floor debt resolved'));
    const notice = make('p', '');
    notice.textContent = count + ' previously accepted ' + plural + ' no longer present on cleanly scanned screens. Run usabl floor prune to remove them and re-arm the gate.';
    section.appendChild(notice);
    return section;
  }

  function renderPanel(host, payload, error) {
    const panel = host.shadowRoot.querySelector('.panel');
    const status = statusFor(payload, error, state.scanning);
    const header = make('header', 'panel-header');
    const titleRow = make('div', 'panel-title-row');
    titleRow.appendChild(make('h2', '', 'Accessibility inspector'));
    appendStatus(titleRow, status);
    header.appendChild(titleRow);
    const summary = make('p', 'summary', error ? 'NOT verified: ' + payload.summary : payload.summary);
    summary.setAttribute('aria-live', 'polite');
    header.appendChild(summary);
    header.appendChild(make('p', 'advisory', 'Advisory view. The stop hook and CI gate decide completion.'));

    const split = partitionByScreen(payload, window.location.pathname);
    const children = [header, renderCurrentScreen(payload, split)];
    const elsewhere = renderElsewhere(split);
    const coverage = renderCoverage(payload);
    const receipt = renderReceipt(payload.receipt);
    const guarded = renderGuardedPaths(payload.dirtyGuardedPaths);
    const floorPaidDown = renderFloorPaidDown(payload.paidDownCount);
    if (elsewhere) children.push(elsewhere);
    children.push(coverage);
    if (receipt) children.push(receipt);
    if (guarded) children.push(guarded);
    if (floorPaidDown) children.push(floorPaidDown);
    panel.replaceChildren(...children);
  }

  function renderLoading(host) {
    clearHighlight();
    const loading = {
      verdict: null,
      summary: 'Scanning affected accessibility surfaces.',
      coverage: { affected: [], unresolvedFiles: [], gaps: [] },
      findings: [],
      receipt: null,
      dirtyGuardedPaths: [],
      paidDownCount: 0,
    };
    state.payload = loading;
    state.error = false;
    state.scanning = true;
    renderLauncher(host, loading, false);
    const panel = host.shadowRoot.querySelector('.panel');
    const header = make('header', 'panel-header');
    header.appendChild(make('h2', '', 'Accessibility inspector'));
    header.appendChild(make('p', 'summary', 'Scanning affected accessibility surfaces.'));
    const section = make('section', 'section');
    section.appendChild(make('h3', '', 'Loading result'));
    section.appendChild(make('div', 'loading-line'));
    section.appendChild(make('div', 'loading-line'));
    panel.replaceChildren(header, section);
  }

  function renderPayload(payload, error = false) {
    const host = ensureInspector();
    state.payload = payload;
    state.error = error;
    state.scanning = false;
    renderLauncher(host, payload, error);
    renderPanel(host, payload, error);
    syncExpansion(host);
  }

  // Re-partition the current-screen and elsewhere split after an in-app route change.
  //
  // A single-page app changes route without a full reload, so the overlay must re-render or it keeps
  // showing the previous screen's findings. We only re-render when a real payload is present and the
  // panel exists; loading and error states re-render on their own paths. Any active highlight is
  // cleared because the located element belonged to the screen we just left.
  function handleRouteChange() {
    if (state.scanning || state.error || !state.payload) {
      return;
    }
    const host = document.getElementById(HOST_ID);
    if (!host || !host.shadowRoot) {
      return;
    }
    clearHighlight();
    renderPanel(host, state.payload, state.error);
    syncExpansion(host);
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

  async function refresh() {
    const host = ensureInspector();
    renderLoading(host);
    try {
      const response = await fetch(RESULT_ENDPOINT, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('status ' + response.status);
      }
      const payload = await response.json();
      renderPayload(payload, false);
    } catch (_err) {
      renderPayload(
        {
          verdict: null,
          summary: 'Inspector could not load the current result. Check the dev server logs.',
          coverage: { affected: [], unresolvedFiles: [], gaps: [] },
          findings: [],
          receipt: null,
          dirtyGuardedPaths: [],
          paidDownCount: 0,
        },
        true,
      );
    }
  }

  hookNavigation();
  refresh();
  if (import.meta && import.meta.hot && typeof import.meta.hot.on === 'function') {
    import.meta.hot.on('usabl:refresh', () => {
      refresh();
    });
  }
})();`;
