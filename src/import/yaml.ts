/**
 * Writes a requirement bundle as YAML that loads back through the normal intake loader unchanged.
 * The header says where the file came from, and the guidance says nothing blocks until a person
 * approves each requirement. Every value is written by the YAML library, which quotes what needs
 * quoting, and each header line is neutralized and kept to one line, so no text can end a comment
 * early and add a key of its own.
 */
import { dump } from 'js-yaml';
import type { RequirementBundle } from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';

const GUIDANCE = [
  '# Every requirement starts with approved: false. It is shown and does not block until a',
  '# person reviews it, sets approved: true, and the change passes owner review.',
];

export function bundleToYaml(bundle: RequirementBundle, options: { header: string }): string {
  const header = options.header
    .split('\n')
    .map((line) => `# ${neutralize(line).replace(/\s+/gu, ' ').trim()}`);
  return [...header, ...GUIDANCE, dump(bundle, { noRefs: true, lineWidth: 100, quotingType: '"' })].join('\n');
}
