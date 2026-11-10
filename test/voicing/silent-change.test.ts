/**
 * The silent change rule with fake pages. An action step that changed the page, was not heard, and
 * did not move focus to a named control is a preview finding, rule voicing/silent-change. A step
 * the rule cannot judge is an unverified gap that names the reason. The rule runs inside the flow
 * provider's loop and the contract step runner, reads around the steps they drive, and drives none.
 * The flow requirement's own verdict reads the union of every step's drain, so it does not change.
 */
import { describe, expect, it } from 'vitest';
import type {
  AnnouncementSource,
  AxTreeNode,
  AxTreeRead,
  Draft,
  FocusUnreadable,
  Page,
  Provider,
  Requirement,
  RequirementBundle,
  Step,
} from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { gate } from '../../src/gate/index.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { makeScanProviders } from '../../src/providers/core-stack.js';
import { runProviders } from '../../src/providers/index.js';
import { summarizePageCheck } from '../../src/surfaces/playwright-helper.js';
import { judgeActionStep, SILENT_CHANGE_RULE, type ActionStepObservation } from '../../src/voicing/silent-change.js';
import { draftsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

function node(nodeId: number, parentId: number | null, role: string, name: string | null, extra: Partial<AxTreeNode> = {}): AxTreeNode {
  return { nodeId, parentId, role, name, ignored: false, states: {}, busy: false, controls: [], ...extra };
}

// The body (10) holds a main landmark with a Save button (3) and a Delete row 2 button (5).
function savePage(): AxTreeNode[] {
  return [
    node(1, null, 'RootWebArea', 'Rows'),
    node(10, 1, 'generic', null, { ignored: true }),
    node(2, 10, 'main', ''),
    node(3, 2, 'button', 'Save'),
    node(4, 3, 'StaticText', 'Save'),
    node(5, 2, 'button', 'Delete row 2'),
    node(6, 2, 'generic', ''),
  ];
}

interface LiveEntry {
  text: string;
  source: AnnouncementSource;
}

// A fake page with a little state. A click or a key press runs the scripted effect for it, which
// can change the tree, move focus, and write live entries. The drain hands back what was written.
interface World {
  tree: AxTreeNode[];
  documentNodeId: number | null;
  focus: number | null;
  focusUnreadable: FocusUnreadable | null;
  live: LiveEntry[];
  url: string;
  settled: boolean;
  undecidable: 'closed-shadow-modal' | null;
  overBudget: boolean;
}

type Effect = (world: World) => void;

interface WorldPage {
  page: Page;
  world: World;
  calls: string[];
}

function worldPage(effects: Record<string, Effect>, start: Partial<World> = {}, controls: Record<string, number | null> = { '#save': 3 }): WorldPage {
  const world: World = {
    tree: savePage(),
    documentNodeId: 1,
    focus: 10,
    focusUnreadable: null,
    live: [],
    url: SCREEN.url,
    settled: true,
    undecidable: null,
    overBudget: false,
    ...start,
  };
  const calls: string[] = [];
  const run = (key: string): void => {
    const effect = effects[key];
    if (effect !== undefined) effect(world);
  };
  const base = makeFakePage({
    currentUrl: async () => world.url,
    click: async (selector) => {
      // A mouse click focuses the button it lands on before the click fires.
      const target = controls[selector];
      if (target !== undefined && target !== null) world.focus = target;
      run(selector);
    },
    press: async (key) => run(key),
    tab: async () => run('Tab'),
    settleAfterAction: async () => ({ settled: world.settled, waitedMs: 0 }),
    controlNodeId: async (selector) => controls[selector] ?? null,
    focusedNodeId: async () => (world.focusUnreadable === null ? world.focus : null),
    activeFocusUnreadable: async () => world.focusUnreadable,
    activePath: async () => (world.focus === null ? 'body' : `#node-${world.focus}`),
    activeNode: async () => {
      const found = world.tree.find((entry) => entry.nodeId === world.focus && !entry.ignored);
      return found === undefined ? null : { name: found.name, role: found.role, states: {} };
    },
    fullAxTree: async (): Promise<AxTreeRead> =>
      world.overBudget ? { kind: 'over-budget', limit: 'nodes' } : { kind: 'tree', documentNodeId: world.documentNodeId, nodes: world.tree.map((entry) => ({ ...entry })) },
    drainAnnouncementSources: async () => {
      const entries = world.live.splice(0, world.live.length);
      return { texts: entries.map((entry) => entry.text), undecidable: world.undecidable, sources: entries.map((entry) => entry.source) };
    },
  });
  const page = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function' && typeof property === 'string') {
        return (...args: unknown[]) => {
          calls.push(property);
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { page, world, calls };
}

const addSavedText: Effect = (world) => {
  world.tree = [...world.tree, node(7, 6, 'StaticText', 'Saved')];
};

function say(world: World, text: string, region = 1, removalOnly = false): void {
  world.live.push({ text, source: { region, removalOnly } });
}

function flowRequirement(steps: Step[], expectedAnnouncement?: string): Requirement {
  return {
    id: 'save-flow',
    kind: 'flow',
    surface: SCREEN.id,
    description: 'Saving',
    approved: true,
    assertion: { type: 'flow', steps, ...(expectedAnnouncement === undefined ? {} : { expectedAnnouncement }) },
  };
}

function voiceRequirement(steps: Step[]): Requirement {
  return {
    id: 'save-voice',
    kind: 'voice',
    surface: SCREEN.id,
    description: 'Saving',
    approved: true,
    assertion: { type: 'voice', steps, obligations: [{ class: 'live-polite', afterStep: 0, requiredTokens: ['saved'], mustAnnounce: true }] },
  };
}

function bundle(...requirements: Requirement[]): RequirementBundle {
  return { version: 1, requirements };
}

async function runOne(provider: Provider | undefined, page: Page): Promise<Draft[]> {
  if (provider === undefined) throw new Error('no provider');
  return draftsOf(await provider.run({ page, screen: SCREEN, config: testConfig() }));
}

async function flowDrafts(effects: Record<string, Effect>, steps: Step[] = [{ do: 'click', selector: '#save' }], start: Partial<World> = {}, controls?: Record<string, number | null>): Promise<Draft[]> {
  const { page } = worldPage(effects, start, controls);
  return runOne(mapRequirementsToProviders(bundle(flowRequirement(steps)))[0], page);
}

function silent(drafts: Draft[]): Draft[] {
  return drafts.filter((draft) => draft.rule === SILENT_CHANGE_RULE);
}

function reasons(drafts: Draft[]): unknown[] {
  return silent(drafts).map((draft) => (draft.confidence === 'fail' ? 'finding' : draft.evidence.extra?.reason));
}

describe('the silent change rule in a flow requirement', () => {
  it('reports a silent Save as a preview finding on the control that received the action', async () => {
    const drafts = await flowDrafts({ '#save': addSavedText });

    expect(drafts).toEqual([
      expect.objectContaining({
        rule: 'voicing/silent-change',
        layer: 'voicing',
        severity: 'serious',
        evidenceClass: 'preview',
        confidence: 'fail',
        screenId: SCREEN.id,
        elementPath: '#save',
        elementName: null,
        role: 'button',
        fix: 'Announce the outcome in a live region that is shown and inside the open modal, or move focus to a control whose name states it.',
        evidence: {
          extra: {
            step: { do: 'click', selector: '#save' },
            added: { StaticText: 1 },
            removed: {},
            changed: {},
            addedNames: ['Saved'],
          },
        },
      }),
    ]);
  });

  it('finds nothing when a live region announced the change', async () => {
    expect(await flowDrafts({ '#save': (world) => (addSavedText(world), say(world, 'Saved')) })).toEqual([]);
  });

  it('finds nothing when focus moved to a named control', async () => {
    expect(await flowDrafts({ '#save': (world) => (addSavedText(world), (world.focus = 5)) })).toEqual([]);
  });

  it('finds nothing when the step changed nothing assistive technology perceives', async () => {
    expect(await flowDrafts({})).toEqual([]);
  });

  it('reads focus on an unnamed node, or left on the control that was clicked, as no move', async () => {
    expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), (world.focus = 6)) }))).toEqual(['finding']);
    expect(reasons(await flowDrafts({ '#save': addSavedText }))).toEqual(['finding']);
  });

  it('reads a name change on the control while it keeps focus as the control speaking for itself', async () => {
    const renamed: Effect = (world) => {
      world.tree = world.tree.map((entry) => (entry.nodeId === 3 || entry.nodeId === 4 ? { ...entry, name: 'Saved' } : entry));
    };
    expect(await flowDrafts({ '#save': renamed })).toEqual([]);
  });

  it('never credits a record that holds only a removal, which is how a toast that dismisses itself shows up', async () => {
    expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), say(world, 'Saved earlier', 1, true)) }))).toEqual(['finding']);
  });

  it('reports a delete that removes its row and leaves focus on the body, and never names the row', async () => {
    const start = {
      tree: [...savePage(), node(20, 2, 'row', 'alice@example.com'), node(21, 20, 'cell', 'alice@example.com'), node(22, 20, 'button', 'Delete alice@example.com')],
    };
    const removeRow: Effect = (world) => {
      world.tree = world.tree.filter((entry) => ![20, 21, 22].includes(entry.nodeId));
      world.focus = 10;
    };
    const drafts = await flowDrafts({ '#delete': removeRow }, [{ do: 'click', selector: '#delete' }], start, { '#delete': 22 });

    expect(reasons(drafts)).toEqual(['finding']);
    expect(drafts[0]?.evidence.extra).toMatchObject({ removed: { button: 1, cell: 1, row: 1 }, addedNames: [] });
    expect(JSON.stringify(drafts)).not.toContain('alice');
  });

  it('shows at most three added names, sorted, and scrubs them', async () => {
    const many: Effect = (world) => {
      world.tree = [
        ...world.tree,
        node(30, 6, 'StaticText', 'delta'),
        node(31, 6, 'StaticText', 'password=hunter2'),
        node(32, 6, 'StaticText', 'beta'),
        node(33, 6, 'StaticText', 'alpha'),
      ];
    };
    const drafts = await flowDrafts({ '#save': many });
    const names = drafts[0]?.evidence.extra?.addedNames;

    expect(names).toEqual(['alpha', 'beta', 'delta']);
    const scrubbed = await flowDrafts({ '#save': (world) => (world.tree = [...world.tree, node(31, 6, 'StaticText', 'password=hunter2')]) });
    expect(JSON.stringify(scrubbed)).not.toContain('hunter2');
  });

  describe('a step it cannot judge is a gap that names the reason', () => {
    it('navigated: the address path changed, or a new document loaded', async () => {
      expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), (world.url = 'http://127.0.0.1:5173/other')) }))).toEqual(['navigated']);
      expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), (world.documentNodeId = 99)) }))).toEqual(['navigated']);
      // A query or fragment change is not the path changing.
      expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), (world.url = `${SCREEN.url}?saved=1#top`)) }))).toEqual(['finding']);
    });

    it('not settled, still busy, and a tree read over budget', async () => {
      expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), (world.settled = false)) }))).toEqual(['not settled']);
      const busy: Effect = (world) => {
        world.tree = [...world.tree.map((entry) => (entry.nodeId === 6 ? { ...entry, busy: true } : entry)), node(7, 6, 'StaticText', 'Saving')];
      };
      expect(reasons(await flowDrafts({ '#save': busy }))).toEqual(['still busy']);
      expect(reasons(await flowDrafts({ '#save': (world) => (world.overBudget = true) }))).toEqual(['tree over budget']);
    });

    it('unreadable control, when the page changed and the click selector named no one element', async () => {
      expect(reasons(await flowDrafts({ '#save': addSavedText }, undefined, {}, { '#save': null }))).toEqual(['unreadable control']);
      expect(await flowDrafts({}, undefined, {}, { '#save': null })).toEqual([]);
    });

    it('focus unreadable, and a drain that cannot say what was heard', async () => {
      expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), (world.focusUnreadable = 'closed-shadow-root')) }))).toEqual(['focus unreadable']);
      expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), say(world, 'Saved'), (world.undecidable = 'closed-shadow-modal')) }))).toEqual([
        'announcements undecidable',
      ]);
    });

    it('replaced focus: a new node with the same name as the control has focus', async () => {
      const rerender: Effect = (world) => {
        world.tree = [...world.tree.filter((entry) => entry.nodeId !== 3 && entry.nodeId !== 4), node(40, 2, 'button', 'Save'), node(41, 40, 'StaticText', 'Save')];
        world.focus = 40;
      };
      expect(reasons(await flowDrafts({ '#save': rerender }))).toEqual(['replaced focus']);
    });

    it('background announcements: the only speech came from a region that also wrote before the first step', async () => {
      const ticker = { live: [{ text: 'Updated 3 s ago', source: { region: 9, removalOnly: false } }] };
      expect(reasons(await flowDrafts({ '#save': (world) => (addSavedText(world), say(world, 'Updated 4 s ago', 9)) }, undefined, ticker))).toEqual([
        'background announcements',
      ]);
      // Another region heard in the same window is speech the action caused.
      expect(await flowDrafts({ '#save': (world) => (addSavedText(world), say(world, 'Updated 4 s ago', 9), say(world, 'Saved', 1)) }, undefined, ticker)).toEqual([]);
      // A toast that dismissed itself before the flow is a removal, not a region that writes on its own.
      const dismissed = { live: [{ text: 'Saved earlier', source: { region: 9, removalOnly: true } }] };
      expect(await flowDrafts({ '#save': (world) => (addSavedText(world), say(world, 'Saved', 9)) }, undefined, dismissed)).toEqual([]);
    });

    it('step not run: the flow driver reports a step kind it does not run instead of ignoring it', async () => {
      // The flow runs none of its steps and is not covered. The rule's gap for each step comes with it.
      const { page, calls } = worldPage({});
      const provider = mapRequirementsToProviders(bundle(flowRequirement([{ do: 'hover', selector: '#save' }, { do: 'click' }, { do: 'press' }])))[0];
      if (provider === undefined) throw new Error('no provider');
      const result = await runProviders([provider], { page, screen: SCREEN, config: testConfig() }, ['live']);
      const drafts = result.drafts;
      expect(reasons(drafts)).toEqual(['step not run', 'step not run', 'step not run']);
      expect(drafts.map((draft) => draft.confidence)).toEqual(['unverified', 'unverified', 'unverified']);
      expect(result.gaps.map((gap) => [gap.ref, gap.state])).toEqual([['provider:intake:save-flow', 'not-covered']]);
      expect(calls).not.toContain('click');
      expect(calls).not.toContain('press');
    });

    it('step threw: the step and those after it are unjudged, and the flow still fails with the same gap', async () => {
      const { page } = worldPage({
        '#save': addSavedText,
        '#broken': () => {
          throw new Error('click timed out on #broken');
        },
      });
      const provider = mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#save' }, { do: 'click', selector: '#broken' }, { do: 'tab' }])))[0];
      if (provider === undefined) throw new Error('no provider');

      await expect(provider.run({ page, screen: SCREEN, config: testConfig() })).rejects.toThrow('click timed out on #broken');
      const { page: again } = worldPage({
        '#save': addSavedText,
        '#broken': () => {
          throw new Error('click timed out on #broken');
        },
      });
      const result = await runProviders([provider], { page: again, screen: SCREEN, config: testConfig() }, ['live']);
      expect(result.gaps).toEqual([{ ref: 'provider:intake:save-flow', state: 'not-covered', reason: 'provider intake:save-flow failed: click timed out on #broken' }]);
      expect(reasons(result.drafts)).toEqual(['finding', 'step threw']);
      expect(result.drafts[1]?.why).toContain('the steps after it were not judged');
    });

    it('step threw: the draft keeps only the first line of the error, never the call log', async () => {
      const message = [
        'click timed out on #delete after 5000ms',
        'Call log:',
        '  - waiting for locator(\'#delete\')',
        '  - locator resolved to <button id="delete" aria-label="Delete alice@example.com">Delete</button>',
      ].join('\n');
      const { page } = worldPage({
        '#delete': () => {
          throw new Error(message);
        },
      });
      const provider = mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#delete' }])))[0];
      if (provider === undefined) throw new Error('no provider');
      const result = await runProviders([provider], { page, screen: SCREEN, config: testConfig() }, ['live']);
      const threw = silent(result.drafts);
      expect(reasons(threw)).toEqual(['step threw']);
      expect(threw[0]?.why).toContain('(click timed out on #delete after 5000ms)');
      const shown = JSON.stringify(threw);
      expect(shown).not.toContain('Call log');
      expect(shown).not.toContain('alice');
      expect(shown).not.toContain('<button');
    });

    it('read failed: the draft keeps only the first line of the error, never the call log', async () => {
      const message = [
        'Accessibility.getFullAXTree failed',
        'Call log:',
        '  - reading node <button id="delete" aria-label="Delete alice@example.com">Delete</button>',
      ].join('\n');
      const { page } = worldPage({ '#save': addSavedText });
      let reads = 0;
      const failing = new Proxy(page, {
        get(target, property, receiver) {
          if (property === 'fullAxTree') {
            return async () => {
              reads += 1;
              // The read before the step works, and the read after it fails.
              if (reads > 1) throw new Error(message);
              return target.fullAxTree();
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const drafts = silent(await runOne(mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#save' }])))[0], failing));
      expect(reasons(drafts)).toEqual(['read failed']);
      expect(drafts[0]?.why).toContain('(Accessibility.getFullAXTree failed)');
      const shown = JSON.stringify(drafts);
      expect(shown).not.toContain('Call log');
      expect(shown).not.toContain('alice');
      expect(shown).not.toContain('<button');
    });

    it('every gap is preview and unverified, with the step in its evidence', async () => {
      const drafts = await flowDrafts({ '#save': (world) => (addSavedText(world), (world.settled = false)) });
      expect(drafts[0]).toMatchObject({
        rule: 'voicing/silent-change',
        evidenceClass: 'preview',
        confidence: 'unverified',
        elementPath: '#save',
        evidence: { extra: { step: { do: 'click', selector: '#save' }, reason: 'not settled' } },
      });
    });
  });

  describe('the flow requirement itself', () => {
    it('keeps its verdict: an announcement drained on step 1 still passes a two-step flow', async () => {
      const { page } = worldPage({ '#save': (world) => (addSavedText(world), say(world, 'Saved')) });
      const provider = mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#save' }, { do: 'tab' }], 'Saved')))[0];
      expect(await runOne(provider, page)).toEqual([]);
    });

    it('does not count the text the capture held before the first step: that speech came from earlier checks', async () => {
      const { page } = worldPage({}, { live: [{ text: 'Saved', source: { region: 1, removalOnly: false } }] });
      const provider = mapRequirementsToProviders(bundle(flowRequirement([{ do: 'tab' }], 'Saved')))[0];
      const drafts = await runOne(provider, page);
      expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:save-flow', 'fail']]);
      expect(drafts[0]?.evidence.extra?.announcements).toEqual([]);
    });

    it('makes the rule emit nothing for the step the flow already fails on', async () => {
      const { page } = worldPage({ '#save': addSavedText });
      const drafts = await runOne(mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#save' }], 'Saved')))[0], page);
      expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:save-flow', 'fail']]);
    });

    it('makes the rule emit nothing for the step the flow already reports as a gap', async () => {
      const { page } = worldPage({ '#save': (world) => (addSavedText(world), (world.undecidable = 'closed-shadow-modal')) });
      const drafts = await runOne(mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#save' }], 'Saved')))[0], page);
      expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:save-flow', 'unverified']]);
    });

    it('keeps a finding on another step when the flow is a gap about an earlier step', async () => {
      const start = { tree: [...savePage(), node(20, 2, 'row', 'Row two'), node(22, 20, 'button', 'Remove row')] };
      const { page } = worldPage(
        {
          // Step 1's drain is undecidable. Step 2 deletes a row, says nothing, and drains clean.
          '#save': (world) => (addSavedText(world), (world.undecidable = 'closed-shadow-modal')),
          '#delete': (world) => {
            world.undecidable = null;
            world.tree = world.tree.filter((entry) => entry.nodeId !== 20 && entry.nodeId !== 22);
            world.focus = 10;
          },
        },
        start,
        { '#save': 3, '#delete': 22 },
      );
      const steps = [{ do: 'click', selector: '#save' }, { do: 'click', selector: '#delete' }];
      const drafts = await runOne(mapRequirementsToProviders(bundle(flowRequirement(steps, 'Saved')))[0], page);
      expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([
        ['intake:save-flow', 'unverified'],
        ['voicing/silent-change', 'fail'],
      ]);
      expect(silent(drafts)[0]?.evidence.extra?.step).toEqual({ do: 'click', selector: '#delete' });
    });

    it('drops the rule gap only on the step whose drain the flow gap reports', async () => {
      const { page } = worldPage(
        {
          '#save': (world) => (addSavedText(world), (world.undecidable = 'closed-shadow-modal')),
          '#other': (world) => (world.tree = [...world.tree, node(8, 6, 'StaticText', 'Done')]),
        },
        {},
        { '#save': 3, '#other': 5 },
      );
      const steps = [{ do: 'click', selector: '#save' }, { do: 'click', selector: '#other' }];
      const drafts = await runOne(mapRequirementsToProviders(bundle(flowRequirement(steps, 'Saved')))[0], page);
      // Step 2's drain is undecidable too, but the flow's gap names the first, so step 2's gap stays.
      expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([
        ['intake:save-flow', 'unverified'],
        ['voicing/silent-change', 'unverified'],
      ]);
      expect(silent(drafts)[0]?.evidence.extra).toMatchObject({ step: { do: 'click', selector: '#other' }, reason: 'announcements undecidable' });
    });

    it('never names the drain taken before the first step in its gap, so the gap covers the step it names', async () => {
      const { page } = worldPage({ '#save': addSavedText }, { undecidable: 'closed-shadow-modal' });
      const drafts = await runOne(mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#save' }], 'Saved')))[0], page);
      // The world stays undecidable, so the drain before the first step and the step's own drain are
      // both undecidable. The flow reads only the step's drain, so its gap names step 0, and the
      // rule drops its own gap there as a repeat.
      expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:save-flow', 'unverified']]);
    });

    it('is judged on its own steps when only the drain taken before the first step is undecidable', async () => {
      const { page } = worldPage(
        { '#save': (world) => (addSavedText(world), (world.undecidable = null), say(world, 'Saved')) },
        { undecidable: 'closed-shadow-modal' },
      );
      const drafts = await runOne(mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#save' }], 'Saved')))[0], page);
      expect(drafts).toEqual([]);
    });

    it('still reports an earlier silent step when the flow fails on its last step', async () => {
      const { page } = worldPage({ '#save': addSavedText }, {}, { '#save': 3, '#other': 5 });
      const steps = [{ do: 'click', selector: '#save' }, { do: 'click', selector: '#other' }];
      const drafts = await runOne(mapRequirementsToProviders(bundle(flowRequirement(steps, 'Done')))[0], page);
      expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([
        ['intake:save-flow', 'fail'],
        ['voicing/silent-change', 'fail'],
      ]);
    });

    it('drives each step once and calls nothing but reads around it', async () => {
      const { page, calls } = worldPage({ '#save': addSavedText });
      await runOne(mapRequirementsToProviders(bundle(flowRequirement([{ do: 'click', selector: '#save' }], 'Saved')))[0], page);
      const driven = calls.filter((call) => ['click', 'press', 'tab', 'focusBody', 'gotoReady', 'setViewport', 'setZoom', 'setReducedMotion'].includes(call));
      expect(driven).toEqual(['click']);
      const READS = new Set([
        'armAnnouncementCapture',
        'drainAnnouncementSources',
        'drainAnnouncementRecord',
        'drainAnnouncements',
        'settleAfterAction',
        'currentUrl',
        'controlNodeId',
        'focusedNodeId',
        'activeFocusUnreadable',
        'activePath',
        'activeNode',
        'fullAxTree',
        'click',
      ]);
      expect(calls.filter((call) => !READS.has(call))).toEqual([]);
    });

    it('gives the same drafts on two runs of the same steps', async () => {
      const first = await flowDrafts({ '#save': addSavedText });
      const second = await flowDrafts({ '#save': addSavedText });
      expect(second).toEqual(first);
    });
  });
});

describe('the silent change rule in a voice contract', () => {
  it('reports a silent Save beside the contract drafts, under its own rule id', async () => {
    const { page } = worldPage({ '#save': addSavedText });
    const drafts = await runOne(mapRequirementsToProviders(bundle(voiceRequirement([{ do: 'click', selector: '#save' }])))[0], page);
    expect(silent(drafts).map((draft) => [draft.rule, draft.evidenceClass, draft.confidence, draft.elementPath])).toEqual([
      ['voicing/silent-change', 'preview', 'fail', '#save'],
    ]);
    expect(drafts.filter((draft) => draft.rule.startsWith('intake:save-voice/')).length).toBeGreaterThan(0);
  });

  it('reports the step that threw, and the contract still fails with the same gap', async () => {
    const { page } = worldPage({
      '#broken': () => {
        throw new Error('click timed out on #broken');
      },
    });
    const provider = mapRequirementsToProviders(bundle(voiceRequirement([{ do: 'click', selector: '#broken' }])))[0];
    if (provider === undefined) throw new Error('no provider');
    const result = await runProviders([provider], { page, screen: SCREEN, config: testConfig() }, ['live']);
    expect(result.gaps.map((gap) => gap.reason)).toEqual(['provider intake:save-voice failed: click timed out on #broken']);
    expect(reasons(result.drafts)).toEqual(['step threw']);
  });
});

describe('with no flow requirement and no voice contract', () => {
  it('nothing runs and no provider is added', async () => {
    const content: Requirement = {
      id: 'heading',
      kind: 'content',
      surface: SCREEN.id,
      description: 'heading',
      approved: true,
      assertion: { type: 'content', selector: 'h1', expectedText: 'Clusters' },
    };
    expect(makeScanProviders(bundle(content)).map((provider) => provider.id)).toEqual([
      'axe-core',
      'pf-rulepack',
      'rhds-rulepack',
      'docs-rulepack',
      'keyboard-walk',
      'intake:heading',
    ]);
    const { page, calls } = worldPage({ '#save': addSavedText });
    await runOne(mapRequirementsToProviders(bundle(content))[0], page);
    expect(calls).not.toContain('fullAxTree');
  });
});

describe('preview, never blocking', () => {
  async function onlySilentChange(): Promise<Draft[]> {
    const finding = await flowDrafts({ '#save': addSavedText });
    const unjudged = await flowDrafts({ '#save': (world) => (addSavedText(world), (world.settled = false)) });
    return [...finding, ...unjudged];
  }

  it('does not change the verdict of a run whose only drafts are voicing/silent-change', async () => {
    const drafts = await onlySilentChange();
    expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([
      ['voicing/silent-change', 'fail'],
      ['voicing/silent-change', 'unverified'],
    ]);
    const out = gate({
      coverage: {
        changedFiles: ['fixtures/app/src/ClustersPage.tsx'],
        affected: [{ screenId: SCREEN.id, url: SCREEN.url, provenance: 'manual' }],
        unresolvedFiles: [],
        gaps: [],
        nothingToCheck: false,
      },
      guardDivergedPaths: [],
      drafts,
      floor: { version: 2, entries: [] },
      waivers: [],
      now: '2026-01-01T00:00:00.000Z',
      cleanlyScannedScreens: new Set([SCREEN.id]),
    });
    expect(out.verdict).toBe('verified');
    expect(out.exitCode).toBe(0);
  });

  it('is advisory in checkPage: the summary counts only deterministic drafts', async () => {
    const result = summarizePageCheck(await onlySilentChange(), []);
    expect(result.verdict).toBe('verified');
    expect(result.failures).toEqual([]);
    expect(result.needsReview).toEqual([]);
    expect(result.advisory?.map((draft) => draft.rule)).toEqual(['voicing/silent-change', 'voicing/silent-change']);
    expect(result.summary).toContain('verified: 0 blocking, 0 needs review, 0 gap(s)');
  });
});

describe('judgeActionStep', () => {
  const tree = (nodes: AxTreeNode[]): AxTreeRead => ({ kind: 'tree', documentNodeId: 1, nodes });
  const observation = (overrides: Partial<ActionStepObservation> = {}): ActionStepObservation => ({
    step: { do: 'activate' },
    acted: 3,
    focusBefore: 3,
    focusUnreadableBefore: null,
    focusAfter: 3,
    focusUnreadableAfter: null,
    urlBefore: SCREEN.url,
    urlAfter: SCREEN.url,
    before: tree(savePage()),
    after: tree([...savePage(), node(7, 6, 'StaticText', 'Saved')]),
    settle: { settled: true, waitedMs: 0 },
    drain: { texts: [], undecidable: null, sources: [] },
    readError: null,
    ...overrides,
  });
  const background = { regions: new Set<number>(), unknown: false };

  it('reads an Enter on a control whose focus could not be read as focus unreadable', () => {
    expect(judgeActionStep(observation({ acted: null, focusBefore: null, focusUnreadableBefore: 'frame-unreadable' }), background)).toEqual({
      kind: 'gap',
      reason: 'focus unreadable',
    });
  });

  it('reads a failed read or drain as a gap before anything else', () => {
    expect(judgeActionStep(observation({ readError: 'the page closed' }), background)).toEqual({ kind: 'gap', reason: 'read failed' });
    expect(judgeActionStep(observation({ drain: null }), background)).toEqual({ kind: 'gap', reason: 'read failed' });
  });

  it('reads a drain whose sources are unknown, with text in it, as undecidable', () => {
    expect(judgeActionStep(observation({ drain: { texts: ['Saved'], undecidable: null, sources: null } }), background)).toEqual({
      kind: 'gap',
      reason: 'announcements undecidable',
    });
  });

  it('names an undecidable drain before an unreadable focus, so the flow gap for that drain covers the step', () => {
    const drain = { texts: ['Saved'], undecidable: 'closed-shadow-modal' as const, sources: [{ region: 1, removalOnly: false }] };
    expect(judgeActionStep(observation({ drain, focusAfter: null, focusUnreadableAfter: 'closed-shadow-root' }), background)).toEqual({
      kind: 'gap',
      reason: 'announcements undecidable',
    });
  });

  it('reads focus on a node outside the tree after the step, such as one in a child frame, as focus unreadable', () => {
    // The focus read follows same-origin frames, and the tree read covers only the main frame.
    const step = { do: 'click', selector: '#save' };
    expect(judgeActionStep(observation({ step, focusAfter: 99 }), background)).toEqual({ kind: 'gap', reason: 'focus unreadable' });
    // Never a pass on the frame's focus, and never a finding, whatever the tree says.
    expect(judgeActionStep(observation({ step, focusBefore: 10, focusAfter: 99 }), background)).toEqual({ kind: 'gap', reason: 'focus unreadable' });
  });

  it('reads speech when the drain before the first step held text of unknown source as background', () => {
    const drain = { texts: ['Saved'], undecidable: null, sources: [{ region: 1, removalOnly: false }] };
    expect(judgeActionStep(observation({ drain }), { regions: new Set(), unknown: true })).toEqual({ kind: 'gap', reason: 'background announcements' });
  });
});
