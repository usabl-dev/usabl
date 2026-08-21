/**
 * Keyboard walk provider that checks Tab stops for unnamed interactive controls and unknown focus.
 * It must never mint a verdict, and it must never guess when the AX node is missing.
 * Missing focus metadata stays unverified so the gate can disclose uncertainty honestly.
 */
import type { AxNode, Draft, Fact, Provider } from '../../contracts/index.js';
import { makeStepRunner } from './steps.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'checkbox',
  'radio',
  'textbox',
  'combobox',
  'tab',
  'switch',
  'option',
]);

export interface KeyboardWalkProviderOptions {
  tabCap?: number;
  wallClockMs?: number;
  now?: () => number;
}

function isUnnamedInteractive(node: AxNode): boolean {
  if (node.role === null) {
    return false;
  }
  return INTERACTIVE_ROLES.has(node.role) && !node.name;
}

function roleFact(role: string | null): { role?: Fact } {
  if (typeof role !== 'string') {
    return {};
  }
  return {
    role: {
      value: role,
      source: 'ax-tree',
      fromTree: true,
    },
  };
}

function tabStopPath(path: string, index: number): string {
  return path === '' ? `tab-stop-${index}` : path;
}

function unconfirmedFocusDraft(screenId: string, elementPath: string): Draft {
  return {
    rule: 'keyboard-walk-unconfirmed-focus',
    layer: 'walk',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath,
    elementName: null,
    role: null,
    whatUserExperiences:
      'A focusable element exists but its accessible role and name cannot be determined.',
    why: 'Keyboard users reach this element but AT cannot announce what it is.',
    fix: 'Give the element a semantic HTML role or an explicit ARIA role, plus an accessible name.',
    evidence: {},
    confidence: 'unverified',
  };
}

function unnamedInteractiveDraft(screenId: string, elementPath: string, node: AxNode): Draft {
  return {
    rule: 'keyboard-walk-unnamed-interactive',
    layer: 'walk',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath,
    elementName: null,
    role: node.role,
    whatUserExperiences:
      'An interactive element has no accessible name; screen-reader users hear only the role.',
    why: `A ${node.role} reached via Tab has no accessible name in the AX tree.`,
    fix: 'Add aria-label or visible text to the element.',
    evidence: roleFact(node.role),
    confidence: 'fail',
  };
}

export function makeKeyboardWalkProvider(options: KeyboardWalkProviderOptions = {}): Provider {
  const tabCap = options.tabCap ?? 200;
  const now = options.now ?? (() => Date.now());
  const deadline = options.wallClockMs === undefined ? null : now() + options.wallClockMs;
  const stepRunner = makeStepRunner();

  return {
    id: 'keyboard-walk',
    layer: 'walk',
    capabilities: ['live'],
    async run(ctx): Promise<Draft[]> {
      await ctx.page.focusBody();

      const drafts: Draft[] = [];
      const seenPaths = new Set<string>();

      for (let i = 0; i < tabCap; i += 1) {
        if (deadline !== null && now() >= deadline) {
          break;
        }

        const stops = await stepRunner.run(ctx.page, [{ do: 'tab' }]);
        const path = tabStopPath(stops[0]?.elementPath ?? '', i);
        if (seenPaths.has(path)) {
          break;
        }
        seenPaths.add(path);

        const node = await ctx.page.activeNode();
        if (node === null) {
          drafts.push(unconfirmedFocusDraft(ctx.screen.id, path));
          continue;
        }

        if (isUnnamedInteractive(node)) {
          drafts.push(unnamedInteractiveDraft(ctx.screen.id, path, node));
        }
      }

      return drafts;
    },
  };
}
