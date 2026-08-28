/**
 * Resolve intake config from trusted-ref config bytes when available.
 * This unit protects requirement provider wiring only.
 * It must never accept PR-only intake roots when trusted policy cannot be parsed.
 */
import type { GitReader, UsablConfig } from '../contracts/index.js';
import { parseUsablConfig } from './config.js';

function withoutRequirements(config: UsablConfig): UsablConfig {
  const { requirements: _requirements, ...rest } = config;
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
    return withoutRequirements(config);
  }

  try {
    return parseUsablConfig(raw);
  } catch {
    // Parse failure means policy is untrusted. Keep scanning paths from caller config but
    // deny requirement provider loading by clearing the requirements root.
    return withoutRequirements(config);
  }
}
