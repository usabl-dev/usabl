/**
 * What a provider can say about a screen before any page opens. `usabl brief` prints it so an
 * agent knows which checks a screen gets before it starts a task. It is measurement: it never
 * decides a verdict, and it never guesses. A provider that cannot know without the page says so,
 * and a provider that says nothing is treated the same way.
 */
import type { PlannedApplicability, PlannedScreen, Provider } from '../contracts/index.js';

// The answer for a check whose applicability is only known on a live page, such as a rulepack
// that runs only when the page carries its design system marker.
export const DECIDED_ON_PAGE = 'decided on the page';

// The answer for a commercial engine the config turned on. Its findings are preview in this
// release, so an agent must not count on it to move the verdict either way. This holds because
// buildDeps passes the engines no promote list and no evidenceClass option, so every engine
// finding stays preview. If buildDeps ever passes either one, this sentence must change with it.
export const ENGINE_PREVIEW = 'turned on in config; its findings are preview and never move the verdict';

export function plannedApplicability(provider: Provider, screen: PlannedScreen): PlannedApplicability {
  return provider.appliesBeforeScan?.(screen) ?? { applies: true, why: DECIDED_ON_PAGE };
}
