/**
 * Browser client source for the advisory overlay badge.
 * This unit renders read-only status from server projections.
 * It must never influence gate outcomes or trust page text as HTML.
 */
export const overlayClientSource = String.raw`(() => {
  const RESULT_ENDPOINT = '/__usabl/result';
  const BADGE_ID = '__usabl-overlay';
  const FINDINGS_ID = '__usabl-overlay-findings';

  const state = {
    expanded: false,
  };

  function ensureBadge() {
    let badge = document.getElementById(BADGE_ID);
    if (badge) {
      return badge;
    }
    badge = document.createElement('aside');
    badge.id = BADGE_ID;
    badge.style.position = 'fixed';
    badge.style.right = '12px';
    badge.style.bottom = '12px';
    badge.style.maxWidth = '360px';
    badge.style.maxHeight = '40vh';
    badge.style.overflow = 'auto';
    badge.style.padding = '10px';
    badge.style.borderRadius = '8px';
    badge.style.border = '1px solid #444';
    badge.style.background = '#111';
    badge.style.color = '#fff';
    badge.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    badge.style.fontSize = '12px';
    badge.style.zIndex = '2147483647';
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.style.background = 'transparent';
    heading.style.border = '0';
    heading.style.color = 'inherit';
    heading.style.cursor = 'pointer';
    heading.style.padding = '0';
    heading.style.font = 'inherit';
    heading.style.display = 'block';
    heading.style.marginBottom = '8px';
    heading.onclick = () => {
      state.expanded = !state.expanded;
      const findings = document.getElementById(FINDINGS_ID);
      if (findings) {
        findings.style.display = state.expanded ? 'block' : 'none';
      }
    };
    badge.appendChild(heading);
    const findings = document.createElement('ul');
    findings.id = FINDINGS_ID;
    findings.style.margin = '0';
    findings.style.paddingLeft = '18px';
    findings.style.display = 'none';
    badge.appendChild(findings);
    document.body.appendChild(badge);
    return badge;
  }

  function renderFinding(list, finding) {
    const item = document.createElement('li');
    const rule = document.createElement('div');
    rule.textContent = finding.rule;
    rule.style.fontWeight = '600';
    const what = document.createElement('div');
    what.textContent = finding.whatUserExperiences;
    const why = document.createElement('div');
    why.textContent = finding.why;
    const fix = document.createElement('div');
    fix.textContent = finding.fix;
    item.appendChild(rule);
    item.appendChild(what);
    item.appendChild(why);
    item.appendChild(fix);
    list.appendChild(item);
  }

  function renderPayload(payload) {
    const badge = ensureBadge();
    const heading = badge.querySelector('button');
    const findings = document.getElementById(FINDINGS_ID);
    if (!heading || !findings) {
      return;
    }
    heading.textContent = 'usabl overlay: ' + (payload.verdict === null ? 'IDLE' : String(payload.verdict).toUpperCase());
    findings.textContent = '';
    if (!Array.isArray(payload.findings) || payload.findings.length === 0) {
      const none = document.createElement('li');
      none.textContent = 'No findings';
      findings.appendChild(none);
      return;
    }
    for (const finding of payload.findings) {
      renderFinding(findings, finding);
    }
  }

  async function refresh() {
    try {
      const response = await fetch(RESULT_ENDPOINT, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('status ' + response.status);
      }
      const payload = await response.json();
      renderPayload(payload);
    } catch (_err) {
      renderPayload({ verdict: 'regression', findings: [{ rule: 'NOT verified', whatUserExperiences: 'overlay fetch failed', why: 'advisory status unavailable', fix: 'check dev server logs' }] });
    }
  }

  refresh();
  if (import.meta && import.meta.hot && typeof import.meta.hot.on === 'function') {
    import.meta.hot.on('usabl:refresh', () => {
      refresh();
    });
  }
})();`;
