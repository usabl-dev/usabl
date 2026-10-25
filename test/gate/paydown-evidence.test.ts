/**
 * The evidence the gate needs before it calls an absent floored barrier fixed, piece by piece.
 *
 * A floored identity missing from the drafts of a cleanly scanned screen is either fixed or was on
 * content that never mounted. The gate tells them apart with what the run showed of the screen:
 * a readiness signal that held, or the identity's own element met by the walk or by a check.
 */
import { describe, expect, it } from 'vitest';
import { gate, paydownConfirmed, renderEvidenceOf } from '../../src/gate/index.js';
import { unconfirmedNotice } from '../../src/output/floor-notice.js';
import { computeIdentity, elementSlots, identitySlot } from '../../src/primitives/identity.js';
import type { Coverage, Draft, EvidenceFloor, FloorEntry, GateInput, ScreenScan } from '../../src/contracts/index.js';

const covered: Coverage = {
  changedFiles: ['x'],
  affected: [
    { screenId: 'orders', url: 'http://app.test/orders', provenance: 'manual' },
    { screenId: 'users', url: 'http://app.test/users', provenance: 'manual' },
  ],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};

function draft(over: Partial<Draft>): Draft {
  return {
    rule: 'link-name',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'orders',
    elementPath: '#orders > tbody:nth-child(1) > tr:nth-child(3) > td:nth-child(2) > a:nth-child(1)',
    elementName: null,
    role: 'link',
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: {},
    confidence: 'fail',
    ...over,
  };
}

function scan(over: Partial<ScreenScan>): ScreenScan {
  return {
    screenId: 'orders',
    url: 'http://app.test/orders',
    stops: [],
    drafts: [],
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
    ...over,
  };
}

function entryFor(d: Draft): FloorEntry {
  const identity = computeIdentity(d);
  return { screenId: d.screenId, layer: d.layer, rule: d.rule, ...identity, count: 1 };
}

function input(floor: EvidenceFloor, screens: ScreenScan[]): GateInput {
  return {
    coverage: covered,
    guardDivergedPaths: [],
    drafts: screens.flatMap((s) => s.drafts),
    floor,
    waivers: [],
    now: '2026-01-01T00:00:00.000Z',
    cleanlyScannedScreens: new Set(screens.filter((s) => s.gaps.length === 0).map((s) => s.screenId)),
    renderEvidence: renderEvidenceOf(screens),
  };
}

describe('identitySlot and elementSlots', () => {
  it('read the same element off a structural key and off the element itself', () => {
    const d = draft({});
    const slot = identitySlot(entryFor(d));
    expect(slot).toBe('path:#orders>tbody>tr>td>a');
    // Another row of the same table neutralizes to the same slot, which is what a structural key
    // already treats as the same identity.
    expect(elementSlots({ elementPath: '#orders > tbody:nth-child(1) > tr:nth-child(9) > td:nth-child(2) > a:nth-child(1)', name: null })).toContain(slot);
  });

  it('read the same element off a name key and off a named element', () => {
    const d = draft({ rule: 'target-size', role: 'button', evidence: { name: { value: 'Delete', source: 'ax-tree', fromTree: true } } });
    expect(identitySlot(entryFor(d))).toBe('name:delete');
    expect(elementSlots({ elementPath: 'main > button', name: 'Delete' })).toContain('name:delete');
  });

  it('keeps a colon inside the path', () => {
    const entry: FloorEntry = {
      screenId: 'orders',
      layer: 'axe',
      rule: 'label',
      elementKey: 'orders|label|struct:textbox:main>input:required',
      identityBasis: 'structural',
      count: 1,
    };
    expect(identitySlot(entry)).toBe('path:main>input:required');
  });

  it('gives no slot for a counted identity or for a key it cannot read', () => {
    expect(identitySlot({ screenId: 'orders', rule: 'button-name', elementKey: null, identityBasis: 'count' })).toBeNull();
    expect(identitySlot({ screenId: 'orders', rule: 'x', elementKey: 'other|x|name:save', identityBasis: 'name' })).toBeNull();
    expect(identitySlot({ screenId: 'orders', rule: 'x', elementKey: 'orders|x|struct:nocolon', identityBasis: 'structural' })).toBeNull();
    expect(identitySlot({ screenId: 'orders', rule: 'x', elementKey: 'orders|x|name:save', identityBasis: 'structural' })).toBeNull();
  });
});

describe('renderEvidenceOf', () => {
  it('holds the signal only when a part was declared and every declared part held', () => {
    const evidence = renderEvidenceOf([
      scan({ screenId: 'a', reachedSelectorPresent: true }),
      scan({ screenId: 'b', reachedSelectorPresent: true, reachedResponseSeen: false }),
      scan({ screenId: 'c', reachedSelectorPresent: null }),
      scan({ screenId: 'd', reachedSelectorPresent: null, reachedResponseSeen: true }),
    ]);
    expect(evidence.get('a')?.signalHeld).toBe(true);
    expect(evidence.get('b')?.signalHeld).toBe(false);
    expect(evidence.get('c')?.signalHeld).toBe(false);
    expect(evidence.get('d')?.signalHeld).toBe(true);
  });

  it('keeps a held signal for a screen scanned twice only when both scans held it', () => {
    const evidence = renderEvidenceOf([scan({ reachedSelectorPresent: true }), scan({ reachedSelectorPresent: false })]);
    expect(evidence.get('orders')?.signalHeld).toBe(false);
  });

  it('collects the slots of every keyboard stop and every draft', () => {
    const evidence = renderEvidenceOf([
      scan({
        stops: [
          {
            index: 0,
            elementPath: 'html > body > header > nav > a#home',
            announcement: [{ kind: 'name', text: 'Home', fromTree: true, source: 'ax-tree' }],
          },
        ],
        drafts: [draft({ rule: 'color-contrast', evidence: { name: { value: 'Open A-100', source: 'ax-tree', fromTree: true } } })],
      }),
    ]);
    const slots = evidence.get('orders')?.elementSlots;
    expect(slots?.has('name:home')).toBe(true);
    expect(slots?.has('path:html>body>header>nav>a#home')).toBe(true);
    expect(slots?.has('name:open-a-100')).toBe(true);
    expect(slots?.has('path:#orders>tbody>tr>td>a')).toBe(true);
  });
});

describe('the notice for a pay-down the run cannot confirm', () => {
  const floored = draft({});
  const floor: EvidenceFloor = {
    version: 2,
    entries: [
      entryFor(floored),
      { screenId: 'orders', layer: 'axe', rule: 'button-name', elementKey: null, identityBasis: 'count', count: 3 },
      { screenId: 'users', layer: 'axe', rule: 'button-name', elementKey: null, identityBasis: 'count', count: 1 },
    ],
  };
  const chromeOnly = [
    scan({ stops: [{ index: 0, elementPath: 'html > body > header > nav > a#home', announcement: [] }] }),
    scan({ screenId: 'users', url: 'http://app.test/users', stops: [{ index: 0, elementPath: 'header > a', announcement: [] }] }),
  ];

  it('claims nothing fixed, raises no gap, leaves the verdict alone, and counts barriers per screen', () => {
    const out = gate(input(floor, chromeOnly));
    expect(out.findings).toEqual([]);
    expect(out.floorGaps).toEqual([]);
    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.floorUnconfirmed).toEqual([
      { screenId: 'orders', rules: ['button-name', 'link-name'], barriers: 4 },
      { screenId: 'users', rules: ['button-name'], barriers: 1 },
    ]);
    expect(out.summary).toBe('verified: nothing blocking, 5 recorded barriers not seen, not claimed fixed');
    // Not counted as headroom either: the run cannot say it observed zero there.
    expect(out.floorHeadroom).toEqual([]);
  });

  it('names the screen, the rules, and the fix, and never an element key', () => {
    const out = gate(input(floor, chromeOnly));
    const notice = unconfirmedNotice(out.floorUnconfirmed[0]!);
    expect(notice).toBe(
      '4 recorded barriers on screen orders (button-name, link-name) were not seen in this run, so they ' +
        'are not claimed fixed. If they are fixed, add a reachedWhen signal for this screen or run usabl ' +
        'floor prune --unconfirmed.',
    );
    expect(notice).not.toContain('#orders');
    expect(notice).not.toContain('struct:');
    expect(unconfirmedNotice({ screenId: 'users', rules: ['button-name'], barriers: 1 })).toBe(
      '1 recorded barrier on screen users (button-name) was not seen in this run, so it is not claimed ' +
        'fixed. If it is fixed, add a reachedWhen signal for this screen or run usabl floor prune --unconfirmed.',
    );
  });

  it('does not depend on the order of the floor entries or of the scans', () => {
    const forward = gate(input(floor, chromeOnly));
    const reversed = gate(input({ ...floor, entries: [...floor.entries].reverse() }, [...chromeOnly].reverse()));
    expect(reversed.floorUnconfirmed).toEqual(forward.floorUnconfirmed);
    expect(reversed.findings).toEqual(forward.findings);
    expect(reversed.summary).toBe(forward.summary);
  });

  it('is not raised for a screen the run did not scan cleanly, which makes no claim at all', () => {
    const gapped = [scan({ gaps: [{ ref: 'http://app.test/orders', state: 'not-covered', reason: 'failed' }] })];
    const out = gate(input({ ...floor, entries: floor.entries.filter((e) => e.screenId === 'orders') }, gapped));
    expect(out.floorUnconfirmed).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it('is not raised when the identity is still observed, which is carried debt', () => {
    const out = gate(input({ version: 2, entries: [entryFor(floored)] }, [scan({ drafts: [floored] })]));
    expect(out.floorUnconfirmed).toEqual([]);
    expect(out.findings[0]?.status).toBe('carried');
  });

  it('treats a caller that passes no render evidence as having none', () => {
    const out = gate({ ...input(floor, chromeOnly), renderEvidence: undefined } as unknown as GateInput);
    expect(out.findings.filter((f) => f.status === 'fixed')).toEqual([]);
    expect(out.floorUnconfirmed.map((u) => u.screenId)).toEqual(['orders', 'users']);
  });

  it('is the one rule prune and baseline read: confirmed only with a held signal or the element met', () => {
    const entry = entryFor(floored);
    expect(paydownConfirmed(entry, undefined)).toBe(false);
    expect(paydownConfirmed(entry, { signalHeld: false, elementSlots: new Set() })).toBe(false);
    expect(paydownConfirmed(entry, { signalHeld: true, elementSlots: new Set() })).toBe(true);
    expect(paydownConfirmed(entry, { signalHeld: false, elementSlots: new Set(['path:#orders>tbody>tr>td>a']) })).toBe(true);
  });
});

describe('one absence rule for the gate', () => {
  it('reads a floored identity with only an advisory draft left as absent, as prune and baseline do', () => {
    // The floor counts deterministic barriers, so an advisory draft at the identity is not one of
    // them. With no signal, the run cannot say the barriers are gone, so they are unconfirmed.
    const floor: EvidenceFloor = {
      version: 2,
      entries: [{ screenId: 'orders', layer: 'axe', rule: 'button-name', elementKey: null, identityBasis: 'count', count: 2 }],
    };
    const advisory = draft({ rule: 'button-name', evidenceClass: 'preview', confidence: 'unverified', elementPath: 'header > button' });
    const out = gate(input(floor, [scan({ drafts: [advisory] })]));
    expect(out.floorUnconfirmed).toEqual([{ screenId: 'orders', rules: ['button-name'], barriers: 2 }]);
    expect(out.floorHeadroom).toEqual([]);
    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.exitCode).toBe(0);
  });
});

describe('totals that do not depend on order', () => {
  it('gives the same barrier total for the same floor in either order, even past the safe range', () => {
    const entries: FloorEntry[] = [Number.MAX_SAFE_INTEGER, 2, 1].map((count, index) => ({
      screenId: 'orders', layer: 'axe', rule: 'link-name', elementKey: `orders|link-name|struct:link:#row${index}`,
      identityBasis: 'structural', count,
    }));
    const forward = gate(input({ version: 2, entries }, [scan({})]));
    const reversed = gate(input({ version: 2, entries: [...entries].reverse() }, [scan({})]));
    expect(reversed.floorUnconfirmed).toEqual(forward.floorUnconfirmed);
    expect(reversed.summary).toBe(forward.summary);
  });
});
