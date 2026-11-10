/**
 * `usabl verify sensitivity`: runs the catalog on the Level 1 fixture pages, and with --app on the
 * team's own screens too, then writes the attestation and prints a short summary.
 *
 * It measures. It does not judge. It exits 0 whenever it ran and wrote the attestation, including
 * when entries were missed, and nonzero only when it could not run. It mints no verdict and no
 * receipt.
 */
import type { UsablConfig } from '../../contracts/index.js';
import { scrubString } from '../../surfaces/scrub.js';
import {
  buildAttestation,
  formatAttestationSummary,
  SENSITIVITY_ATTESTATION_PATH,
  serializeAttestation,
  type SensitivityAttestation,
} from './attestation.js';
import { SENSITIVITY_CATALOG } from './catalog.js';
import { LEVEL1_SCREEN_IDS } from './level1.js';
import { formatLevel2Warning, level2Cost, level2Screens, type Level2Requirements } from './level2.js';
import type { EntryMeasurement, SensitivityScreen } from './runner.js';

export interface VerifySensitivityOptions {
  app: boolean;
  screens: readonly string[] | null;
  json: boolean;
}

export interface VerifySensitivityPorts {
  now(): string;
  versions(): Promise<{ runnerVersion: string; scannerVersions: { axeCore: string; playwright: string; chromium: string } }>;
  level1(now: string): Promise<EntryMeasurement[]>;
  loadConfig(): Promise<UsablConfig>;
  // The team's design requirements, read only to count what Level 2 will run before it starts.
  loadRequirements(config: UsablConfig): Promise<Level2Requirements>;
  level2(config: UsablConfig, screens: readonly SensitivityScreen[], now: string): Promise<EntryMeasurement[]>;
  writeAttestation(path: string, text: string): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runVerifySensitivity(options: VerifySensitivityOptions, ports: VerifySensitivityPorts): Promise<number> {
  if (options.screens !== null && !options.app) {
    ports.stderr('usabl: --screen picks app screens, so it needs --app. Level 1 always runs every fixture page.\n');
    return 2;
  }

  let config: UsablConfig | null = null;
  let appScreens: SensitivityScreen[] = [];
  if (options.app) {
    try {
      config = await ports.loadConfig();
    } catch (err) {
      ports.stderr(`usabl: ${scrubString(errorMessage(err))}\n`);
      return 2;
    }
    const picked = level2Screens(config, options.screens);
    if (!picked.ok) {
      ports.stderr(`usabl: ${scrubString(picked.message)}\n`);
      return 2;
    }
    appScreens = picked.screens;
  }

  const date = ports.now();
  let attestation: SensitivityAttestation;
  try {
    const versions = await ports.versions();
    const fixture = await ports.level1(date);
    let app: EntryMeasurement[] | null = null;
    if (config !== null) {
      // Said before it starts, with the real counts, because it loads the app many times and runs the
      // team's own flow and voice steps, which can save or delete data.
      const requirements = await ports.loadRequirements(config);
      const warning = formatLevel2Warning(level2Cost(SENSITIVITY_CATALOG, appScreens, requirements.ok ? requirements.bundle : null));
      // Each line is scrubbed on its own, so the line breaks stay.
      ports.stderr(warning.split('\n').map(scrubString).join('\n'));
      app = await ports.level2(config, appScreens, date);
    }
    attestation = buildAttestation({
      date,
      engineVersion: versions.runnerVersion,
      scannerVersions: versions.scannerVersions,
      fixture: { screens: LEVEL1_SCREEN_IDS, measurements: fixture },
      app: app === null ? null : { screens: appScreens.map((screen) => screen.id), measurements: app },
    });
    await ports.writeAttestation(SENSITIVITY_ATTESTATION_PATH, serializeAttestation(attestation));
  } catch (err) {
    ports.stderr(`usabl: verify sensitivity could not run, so no attestation was written: ${scrubString(errorMessage(err))}\n`);
    return 4;
  }

  ports.stdout(options.json ? serializeAttestation(attestation) : formatAttestationSummary(attestation, SENSITIVITY_ATTESTATION_PATH));
  return 0;
}
