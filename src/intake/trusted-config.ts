/**
 * Resolve intake config from trusted-ref config bytes when available.
 * This unit protects requirement provider and engine provider wiring only.
 * It must never accept PR-only intake roots when trusted policy cannot be parsed.
 */
import type { GitReader, UsablConfig } from '../contracts/index.js';
import { parseUsablConfig } from './config.js';

// Without trusted policy, nothing that trusted policy alone may turn on is kept: the requirements
// root, the origins the judge's browser may reach, the commercial engines, which run vendor
// code that can hold credentials and reach the network, the promoted obligation classes, which
// turn a voice requirement's preview findings into ones that gate, and the keyboard walk settings,
// which set how far the walk goes on each screen.
function withoutTrustedOnlyFields(config: UsablConfig): UsablConfig {
  const {
    requirements: _requirements,
    judge: _judge,
    engines: _engines,
    promotedObligations: _promotedObligations,
    keyboardWalk: _keyboardWalk,
    ...rest
  } = config;
  return rest;
}

export async function resolveIntakeConfig(
  git: Pick<GitReader, 'show'>,
  config: UsablConfig,
  trustedRef: string | undefined,
): Promise<UsablConfig> {
  if (trustedRef === undefined) {
    return config;
  }

  const raw = await git.show(trustedRef, 'usabl.config.json');
  if (raw === null) {
    // Fail closed for intake providers: missing trusted config cannot authorize PR requirement roots.
    return withoutTrustedOnlyFields(config);
  }

  try {
    return parseUsablConfig(raw);
  } catch {
    // Parse failure means policy is untrusted. Keep scanning paths from caller config but
    // deny requirement provider loading by clearing the requirements root.
    return withoutTrustedOnlyFields(config);
  }
}
