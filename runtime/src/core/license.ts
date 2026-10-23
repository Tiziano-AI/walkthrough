import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPrivateFile } from './files.ts';
import { Failure } from './contracts.ts';
import { runtimePaths } from './runtime-paths.ts';

export const REMOTION_VERSION = '4.0.538';
export const REMOTION_LICENSE_URL = `https://github.com/remotion-dev/remotion/blob/v${REMOTION_VERSION}/LICENSE.md`;
/** These are operator assertions, not eligibility determined by Walkthrough. */
export const LICENSE_BASES = ['individual', 'small-organization', 'non-profit', 'evaluation', 'company-license'] as const;
export type LicenseBasis = typeof LICENSE_BASES[number];
export interface LicenseAssertion {
  schemaVersion: 2; version: typeof REMOTION_VERSION; eligibility: LicenseBasis;
  telemetry: false; assertedBy: 'operator';
}
interface HistoricalLicenseAssertion extends Omit<LicenseAssertion, 'schemaVersion' | 'eligibility'> { schemaVersion: 1; eligibility: 'individual' }
export const licensePath = () => join(runtimePaths().configRoot, 'remotion-license.json');

export function validateLicenseAssertion(value: unknown): LicenseAssertion | HistoricalLicenseAssertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LICENSE_ASSERTION_INVALID');
  const fields = value as Record<string, unknown>;
  // Historical assertions may carry opaque operator evidence. Read their
  // original decisive fields without rewriting or adopting that evidence as
  // current setup input; new assertions keep the exact schema below.
  if (![1, 2].includes(fields.schemaVersion as number) || fields.version !== REMOTION_VERSION
    || fields.telemetry !== false || fields.assertedBy !== 'operator'
    || !LICENSE_BASES.includes(fields.eligibility as LicenseBasis)
    || Object.hasOwn(fields, 'licenseKey')
    || fields.schemaVersion === 1 && fields.eligibility !== 'individual'
    || fields.schemaVersion === 2 && Object.keys(fields).sort().join(',') !== 'assertedBy,eligibility,schemaVersion,telemetry,version') throw new Error('LICENSE_ASSERTION_INVALID');
  return value as LicenseAssertion | HistoricalLicenseAssertion;
}

/** Recording a basis requires the operator's explicit choice. No inspection
 * of the machine, repository or account can establish it on their behalf. */
export function operatorLicenseAssertion(basis: LicenseBasis): LicenseAssertion {
  return validateLicenseAssertion({ schemaVersion: 2, version: REMOTION_VERSION, eligibility: basis, telemetry: false, assertedBy: 'operator' }) as LicenseAssertion;
}

export async function verifyLicense(path = licensePath()) {
  try {
    await assertPrivateFile(path);
    const value = validateLicenseAssertion(JSON.parse(await readFile(path, 'utf8')));
    return { renderer: 'Remotion', version: value.version, eligibility: value.eligibility, telemetry: false };
  } catch {
    throw new Failure('LICENSE_ELIGIBILITY_NOT_PROVISIONED', 'licensing',
      `Use setup prepare with the operator's explicit Remotion ${REMOTION_VERSION} license basis, then apply its reviewed candidate. Read ${REMOTION_LICENSE_URL}; Walkthrough does not determine eligibility, purchase a license or send telemetry.`);
  }
}
