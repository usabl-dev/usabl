/**
 * Composition for the optional commercial engines. An engine the config does not turn on
 * contributes no provider, no capability, and no version, so a run without an engines block is
 * exactly the run usabl made before engines existed. This unit never mints a verdict.
 */
import type { Capability, EnginesConfig, Provider } from '../../contracts/index.js';
import { DEQUE_PACKAGE, makeDequeProvider, type DequeProviderOptions } from './deque.js';
import { EVINCED_PACKAGE, makeEvincedProvider, type EvincedProviderOptions } from './evinced.js';
import { probeInstalledPackage, type InstalledPackage } from './shared.js';

export interface EngineProviderOptions {
  // Applied to both engines: the environment they read, read only, and the working folder their
  // outside switch files are looked for in.
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  deque?: DequeProviderOptions;
  evinced?: EvincedProviderOptions;
}

/** One provider per engine the config turns on, Deque first. */
export function makeEngineProviders(engines: EnginesConfig | undefined, options: EngineProviderOptions = {}): Provider[] {
  const shared = {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
  const providers: Provider[] = [];
  if (engines?.deque?.enabled === true) {
    providers.push(makeDequeProvider(engines.deque, { ...shared, ...options.deque }));
  }
  if (engines?.evinced?.enabled === true) {
    providers.push(makeEvincedProvider(engines.evinced, { ...shared, ...options.evinced }));
  }
  return providers;
}

/**
 * The capabilities the turned-on engines declare, read from the providers themselves so the grant
 * and the declaration cannot drift apart. Empty when no engine is on.
 */
export function engineCapabilities(engines: EnginesConfig | undefined): Capability[] {
  return [...new Set(makeEngineProviders(engines).flatMap((provider) => provider.capabilities))];
}

/**
 * The installed package version of each turned-on engine, keyed by engine id, for the receipt. Read
 * from disk without loading vendor code, so the same answer comes back whether or not a scan ran,
 * which is what lets a receipt re-verify without a browser. An engine whose package is not found
 * records "not-installed"; a run like that ends in a coverage gap and mints no receipt. Undefined
 * when no engine is on, so receipts keep their earlier shape.
 */
export async function readEngineVersions(
  engines: EnginesConfig | undefined,
  probe: (packageName: string) => Promise<InstalledPackage> = (name) => probeInstalledPackage(name),
): Promise<Record<string, string> | undefined> {
  const versionOf = async (packageName: string): Promise<string> => {
    const found = await probe(packageName);
    return found.state === 'installed' ? found.version : 'not-installed';
  };
  const versions: Record<string, string> = {};
  if (engines?.deque?.enabled === true) {
    versions['deque'] = await versionOf(DEQUE_PACKAGE);
  }
  if (engines?.evinced?.enabled === true) {
    versions['evinced'] = await versionOf(EVINCED_PACKAGE);
  }
  return Object.keys(versions).length === 0 ? undefined : versions;
}
