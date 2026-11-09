/**
 * `usabl verify sensitivity`: runs the catalog on the Level 1 fixture pages, then writes the
 * attestation and prints a short summary.
 *
 * It measures. It does not judge. It exits 0 whenever it ran and wrote the attestation, including
 * when entries were missed, and nonzero only when it could not run. It mints no verdict and no
 * receipt.
 */
import { scrubString } from '../../surfaces/scrub.js';
import {
  buildAttestation,
  formatAttestationSummary,
  SENSITIVITY_ATTESTATION_PATH,
  serializeAttestation,
  type SensitivityAttestation,
} from './attestation.js';
import { LEVEL1_SCREEN_IDS } from './level1.js';
import type { EntryMeasurement } from './runner.js';

export interface VerifySensitivityOptions {
  json: boolean;
}

export interface VerifySensitivityPorts {
  now(): string;
  versions(): Promise<{ runnerVersion: string; scannerVersions: { axeCore: string; playwright: string; chromium: string } }>;
  level1(now: string): Promise<EntryMeasurement[]>;
  writeAttestation(path: string, text: string): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runVerifySensitivity(options: VerifySensitivityOptions, ports: VerifySensitivityPorts): Promise<number> {
  const date = ports.now();
  let attestation: SensitivityAttestation;
  try {
    const versions = await ports.versions();
    const fixture = await ports.level1(date);
    attestation = buildAttestation({
      date,
      engineVersion: versions.runnerVersion,
      scannerVersions: versions.scannerVersions,
      fixture: { screens: LEVEL1_SCREEN_IDS, measurements: fixture },
      app: null,
    });
    await ports.writeAttestation(SENSITIVITY_ATTESTATION_PATH, serializeAttestation(attestation));
  } catch (err) {
    ports.stderr(`usabl: verify sensitivity could not run, so no attestation was written: ${scrubString(errorMessage(err))}\n`);
    return 4;
  }

  ports.stdout(options.json ? serializeAttestation(attestation) : formatAttestationSummary(attestation, SENSITIVITY_ATTESTATION_PATH));
  return 0;
}
