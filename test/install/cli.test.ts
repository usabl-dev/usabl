/**
 * Parser coverage for the install family and the stop-hook command. install takes
 * exactly one target flag, and the exactly-one rule is enforced by installRefusal,
 * which is asserted to be load-bearing: removing it would let install run with zero
 * or several targets and half-wire the integration.
 */
import { describe, expect, it } from 'vitest';
import {
  INSTALL_TARGET_FLAGS,
  installRefusal,
  parseCliArgs,
} from '../../src/surfaces/cli.js';

describe('parseCliArgs install family', () => {
  it('accepts the stop-hook command', () => {
    expect(parseCliArgs(['stop-hook']).command).toBe('stop-hook');
  });

  it('parses each of the five install target flags', () => {
    expect(parseCliArgs(['install', '--overlay']).installTarget).toBe('overlay');
    expect(parseCliArgs(['install', '--claude']).installTarget).toBe('claude');
    expect(parseCliArgs(['install', '--ci']).installTarget).toBe('ci');
    expect(parseCliArgs(['install', '--docs-ci']).installTarget).toBe('docs-ci');
    expect(parseCliArgs(['install', '--branch-rule']).installTarget).toBe('branch-rule');
    expect(parseCliArgs(['install', '--overlay']).command).toBe('install');
  });

  it('leaves installTarget null when zero target flags are given', () => {
    expect(parseCliArgs(['install']).installTarget).toBeNull();
  });

  it('leaves installTarget null when more than one target flag is given', () => {
    expect(parseCliArgs(['install', '--overlay', '--claude']).installTarget).toBeNull();
    expect(parseCliArgs(['install', '--ci', '--branch-rule']).installTarget).toBeNull();
    // --docs-ci is a distinct target from --ci, so naming both is still ambiguous.
    expect(parseCliArgs(['install', '--ci', '--docs-ci']).installTarget).toBeNull();
  });

  it('does not treat --ci on a non-install command as an install target', () => {
    // --ci keeps its CI-mode meaning on check; it only names a target under install.
    const opts = parseCliArgs(['check', '--ci']);
    expect(opts.ci).toBe(true);
    expect(opts.installTarget).toBeNull();
  });

  it('parses --docs as an init flag, never as an install target', () => {
    // --docs selects the docs-manifest onboarding for init. It is not an install target,
    // so it must never resolve installTarget the way --docs-ci does.
    const initDocs = parseCliArgs(['init', '--docs']);
    expect(initDocs.command).toBe('init');
    expect(initDocs.docs).toBe(true);
    expect(initDocs.installTarget).toBeNull();
    // The two flags are distinct: --docs-ci must not set the init docs flag.
    expect(parseCliArgs(['install', '--docs-ci']).docs).toBe(false);
    // And --docs defaults off elsewhere.
    expect(parseCliArgs(['init']).docs).toBe(false);
  });
});

describe('installRefusal', () => {
  it('names every target flag when refusing zero or multiple targets', () => {
    const zero = installRefusal(parseCliArgs(['install']));
    expect(zero?.exitCode).toBe(2);
    for (const flag of INSTALL_TARGET_FLAGS) {
      expect(zero?.message).toContain(flag);
    }
    expect(installRefusal(parseCliArgs(['install', '--overlay', '--ci']))?.exitCode).toBe(2);
  });

  it('allows install with exactly one target', () => {
    expect(installRefusal(parseCliArgs(['install', '--overlay']))).toBeNull();
  });

  it('does not apply to non-install commands', () => {
    expect(installRefusal(parseCliArgs(['check']))).toBeNull();
    expect(installRefusal(parseCliArgs(['stop-hook']))).toBeNull();
  });
});
