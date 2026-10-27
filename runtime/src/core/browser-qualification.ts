import {createHash} from 'node:crypto';

/** One reviewed browser identity for acquisition, selection and preflight.
 * Playwright's bundled milestone build is not the security-patched CfT build.
 * Updates must review the versioned official metadata and rerun browser/media
 * qualification; production never resolves a moving stable/latest channel. */
export const browserQualification = {
  packageVersion: '1.64.1', installerVersion: '3.2.6', version: '156.0.8078.47',
  metadata: 'https://googlechromelabs.github.io/chrome-for-testing/156.0.8078.47.json',
  metadataSha256: '280a3aaf97babf78351b78176ca4fbf3727bf374752f34ea05aa7753bf423c87',
  executable: 'chrome/mac_arm-156.0.8078.47/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
};
export const qualifiedBrowserVersion = (value: string): boolean => value.trim() === `Google Chrome for Testing ${browserQualification.version}`;

/** Explicit acquisition only. Admit the reviewed official metadata bytes before
 * asking the upstream downloader for their exact version, not a channel. */
export async function verifyBrowserMetadata(request: typeof fetch = fetch): Promise<void> {
  const response = await request(browserQualification.metadata, {redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('BROWSER_METADATA_UNAVAILABLE');
  const bytes = await response.text();
  if (createHash('sha256').update(bytes).digest('hex') !== browserQualification.metadataSha256) throw new Error('BROWSER_METADATA_CHANGED');
}
