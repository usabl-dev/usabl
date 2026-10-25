/**
 * The notice for floored barriers a run did not see and cannot call fixed.
 *
 * One sentence per screen, written once here and printed by every surface: the terminal, the pull
 * request comment, the Stop hook, the self-check, and the overlay through its payload. One source
 * keeps the surfaces from saying different things about the same floor.
 *
 * It names the screen, the rules and the number of barriers, and it gives both ways out: a signal
 * that lets usabl tell a fixed barrier from content that never mounted, or a prune that drops the
 * entries on purpose. It never names an element key, because a key carries page text.
 */
import type { FloorUnconfirmed } from '../contracts/index.js';
import { wholeNumberText } from './carried.js';

/** The heading the terminal and the overlay print above the notices. */
export const UNCONFIRMED_HEADING = 'recorded barriers not seen';

/**
 * The entry is carried by a Result, which a library caller can compose, so each field is read the
 * way a carried value is: the count prints only as a whole number, and the screen id and the rules
 * are turned into text, never trusted to be strings or a list. Callers that print to a model put
 * the whole sentence inside the untrusted frame.
 */
export function unconfirmedNotice(entry: FloorUnconfirmed): string {
  const one = entry.barriers === 1;
  const noun = one ? 'barrier' : 'barriers';
  const was = one ? 'was' : 'were';
  const it = one ? 'it is' : 'they are';
  const rules: unknown = entry.rules;
  const ruleText = Array.isArray(rules) ? rules.map(String).join(', ') : 'rules unreadable';
  return (
    `${wholeNumberText(entry.barriers)} recorded ${noun} on screen ${String(entry.screenId)} (${ruleText}) ` +
    `${was} not seen in this run, so ${it} not claimed fixed. ` +
    `If ${it} fixed, add a reachedWhen signal for this screen or run usabl floor prune --unconfirmed.`
  );
}
