/** Numeric delivery checks do not establish intelligibility or listening quality. */
export const LOUDNESS_POLICY = Object.freeze({
  integratedLufs: -16,
  integratedToleranceLu: 0.5,
  maximumTruePeakDbtp: -1,
  // Leave fixed headroom for AAC; acceptance measures the encoded delivery.
  normalizationTruePeakDbtp: -2,
  // Prefer linear gain without imposing a narrower loudness range on speech.
  normalizationRangeLu: 50,
});

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
  thresholdLufs: number;
}

export interface LoudnormReport {
  input: LoudnessMeasurement;
  output: LoudnessMeasurement;
  normalizationType: 'linear' | 'dynamic';
  targetOffsetDb: number;
}

/** FFmpeg emits one report from the single mapped audio stream. Never take a
 * normalized output_i as the measured input_i of a delivered AAC file. */
export function parseLoudnormReport(log: string): LoudnormReport {
  const reports = [...log.matchAll(/\{\s*"input_i"\s*:[^{}]*\}/g)];
  if (reports.length !== 1) throw new Error('render:audio_loudness_report_invalid');
  let report: Record<string, unknown>;
  try { report = JSON.parse(reports[0][0]); }
  catch { throw new Error('render:audio_loudness_report_invalid'); }
  const number = (key: string) => {
    const value = report[key];
    if (value === '-inf' || value === 'inf' || value === '+inf') throw new Error('render:audio_loudness_unmeasurable');
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) throw new Error('render:audio_loudness_report_invalid');
    return Number(value);
  };
  const measurement = (prefix: 'input' | 'output'): LoudnessMeasurement => ({
    integratedLufs: number(`${prefix}_i`), truePeakDbtp: number(`${prefix}_tp`),
    loudnessRangeLu: number(`${prefix}_lra`), thresholdLufs: number(`${prefix}_thresh`),
  });
  if (report.normalization_type !== 'linear' && report.normalization_type !== 'dynamic') throw new Error('render:audio_loudness_report_invalid');
  return {input: measurement('input'), output: measurement('output'), normalizationType: report.normalization_type, targetOffsetDb: number('target_offset')};
}

export function loudnormFilter(measured?: LoudnormReport): string {
  const settings = [`I=${LOUDNESS_POLICY.integratedLufs}`, `TP=${LOUDNESS_POLICY.normalizationTruePeakDbtp}`, `LRA=${LOUDNESS_POLICY.normalizationRangeLu}`];
  if (measured) {
    const {input, targetOffsetDb} = measured;
    // These are the native filter's accepted measurement ranges. Infinities,
    // missing measurements and out-of-range values cannot turn into defaults.
    for (const [value, minimum, maximum] of [[input.integratedLufs,-99,0], [input.truePeakDbtp,-99,99], [input.loudnessRangeLu,0,99], [input.thresholdLufs,-99,0], [targetOffsetDb,-99,99]]) {
      if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error('render:audio_loudness_unmeasurable');
    }
    settings.push(`measured_I=${input.integratedLufs}`, `measured_TP=${input.truePeakDbtp}`, `measured_LRA=${input.loudnessRangeLu}`, `measured_thresh=${input.thresholdLufs}`, `offset=${targetOffsetDb}`, 'linear=true');
  }
  return `loudnorm=${settings.join(':')}:print_format=json`;
}

/** Dynamic loudnorm can emit discontinuous timestamps at its final block.
 * Count the resampled output samples instead; do not trim, pad or stretch them. */
export function deliveryLoudnormFilter(measured: LoudnormReport): string {
  return `${loudnormFilter(measured)},aresample=48000,asetpts=N/SR/TB`;
}

export function loudnessAcceptance(delivered: LoudnessMeasurement) {
  const integratedLoudness = Number.isFinite(delivered.integratedLufs) && Math.abs(delivered.integratedLufs - LOUDNESS_POLICY.integratedLufs) <= LOUDNESS_POLICY.integratedToleranceLu;
  const truePeak = Number.isFinite(delivered.truePeakDbtp) && delivered.truePeakDbtp <= LOUDNESS_POLICY.maximumTruePeakDbtp;
  return {passed: integratedLoudness && truePeak, integratedLoudness, truePeak};
}
