import { execFile } from 'node:child_process';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { audioEnvironment, defaultVoiceId, digestFile, prepareAudioProvision, provisionVoices, stableJson, validateAudioProvision, verifyAudioProvision, type CurrentAudioProvision } from '../audio/provision.ts';
import { inspectAudioReadiness } from './audio-readiness.ts';
import { Failure, type LocalTools } from './contracts.ts';
import { assertPrivateFile, sha256 } from './files.ts';
import { licensePath, validateLicenseAssertion, verifyLicense, type LicenseAssertion } from './license.ts';
import { runtimePaths } from './runtime-paths.ts';
import { readToolchainSelection, resolveLocalTools, toolchainSelectionPath } from './toolchain.ts';
import { qualifiedNode } from './environment.ts';

type ToolName = keyof LocalTools;
export type SetupToolIdentities = Record<ToolName, { path: string; sha256: string; version: string }>;
type SetupTargets = { toolchain: string; audio: string; license: string; receipt: string };
export interface SetupCandidate {
  schemaVersion: 1; kind: 'walkthrough-setup-candidate';
  targets: SetupTargets; previous: Record<keyof SetupTargets, string | null>;
  tools: LocalTools; toolIdentities: SetupToolIdentities;
  audio: CurrentAudioProvision; license: LicenseAssertion;
}
interface SetupReceipt {
  schemaVersion: 1; kind: 'walkthrough-setup-selection'; candidatePath: string; candidateSha256: string;
  toolIdentities: SetupToolIdentities; audioSha256: string; licenseSha256: string;
}
interface SetupOutput { path: string; temporary: string; before: string | null; after: string; value: unknown }
interface SetupPending { schemaVersion: 1; kind: 'walkthrough-setup-apply'; candidatePath: string; candidateSha256: string; pid: number; outputs: SetupOutput[] }
export interface SetupPrepareInput {
  candidatePath: string; tools?: LocalTools; voicesExecutable: string;
  defaultVoiceId: string; voiceIds?: string[]; license: LicenseAssertion;
  signal?: AbortSignal;
}
interface SetupDependencies {
  inspectTools: typeof inspectSetupTools;
  observeDoctor: typeof observeSetupDoctor;
  prepareAudio: typeof prepareAudioProvision;
}
const defaults: SetupDependencies = { inspectTools: inspectSetupTools, observeDoctor: observeSetupDoctor, prepareAudio: prepareAudioProvision };
const toolNames: ToolName[] = ['nodePath', 'browserPath', 'ffmpegPath', 'ffprobePath'];
const absolute = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !value.includes('\0');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const targets = (): SetupTargets => ({ toolchain: toolchainSelectionPath(), audio: runtimePaths().audioProvisionPath, license: licensePath(), receipt: join(runtimePaths().stateRoot, 'setup-selection.json') });
export const setupPendingPath = () => join(runtimePaths().stateRoot, 'setup-pending.json');
const failure = (code: string, recovery: string) => new Failure(code, 'setup', recovery);
const applyAgain = (candidatePath: string, candidateSha256: string) => `Inspect setup, then rejoin this exact selection with setup apply --candidate ${JSON.stringify(candidatePath)} --sha256 ${candidateSha256}. No browser, inference or downloads were started.`;

async function fingerprint(path: string): Promise<string | null> {
  try {
    await assertPrivateFile(path);
    if ((await lstat(path)).size > 8 * 1024 * 1024) throw failure('SETUP_RECORD_INVALID', 'Preserve the oversized setup record and use its owner to resolve it.');
    return await digestFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function privateDirectory(path: string): Promise<void> {
  if (!absolute(path)) throw failure('SETUP_ABSOLUTE_PATH_REQUIRED', 'Use absolute normalized configuration and candidate paths.');
  const parent = dirname(path);
  if (parent !== path) await privateDirectory(parent);
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw failure('SETUP_PATH_REDIRECT', 'Use literal setup directories, not redirected paths. Existing data was not replaced.');
}
async function writeNew(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(encode(value)); await file.sync(); } finally { await file.close(); }
}
/** The durable apply journal reserves these exact scratch slots before use.
 * Rejoining may replace a torn scratch file, never an unrelated target. */
async function replaceJson(path: string, value: unknown, temporary: string, before: string | null): Promise<void> {
  let exists = false;
  try { await assertPrivateFile(temporary); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = await open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW | (exists ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw failure('SETUP_SCRATCH_INVALID', 'The retained setup scratch no longer has its private regular-file identity. Preserve it and inspect the original setup selection.');
    await file.truncate(0); await file.writeFile(encode(value)); await file.sync();
  } finally { await file.close(); }
  if (await fingerprint(path) !== before) throw failure('SETUP_SELECTION_CHANGED', 'The selected setup changed while its next record was being prepared. Rejoin the original setup apply; no changed record was overwritten.');
  await rename(temporary, path);
}
async function removeScratch(path: string): Promise<void> {
  try { await assertPrivateFile(path); await rm(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const journalTemporary = (candidateSha256: string) => `${setupPendingPath()}.setup-${candidateSha256}.next`;

/** Bounded public command observation, without inheriting credentials or
 * model/provider overrides. Its caller's OS sandbox remains in effect. */
async function command(executable: string, args: string[], options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  if (!absolute(executable)) throw failure('SETUP_EXECUTABLE_PATH_REQUIRED', 'Supply the absolute path of an installed executable.');
  await access(executable, constants.X_OK);
  return new Promise((accept, reject) => {
    execFile(executable, args, { env: options.env ?? { HOME: homedir(), PATH: [dirname(executable), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), LANG: 'en_US.UTF-8', DO_NOT_TRACK: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL', signal: options.signal }, (error, stdout) => {
      if (!error) return accept(stdout);
      reject(failure(options.signal?.aborted ? 'SETUP_OBSERVATION_ABORTED' : error.killed ? 'SETUP_OBSERVATION_TIMEOUT' : 'SETUP_EXECUTABLE_UNAVAILABLE', 'The selected prerequisite did not return a bounded public response. Inspect that installation; no setup selection was changed.'));
    });
  });
}
export async function inspectSetupTools(tools: LocalTools, signal?: AbortSignal): Promise<SetupToolIdentities> {
  if (!record(tools) || Object.keys(tools).sort().join(',') !== [...toolNames].sort().join(',') || toolNames.some(key => !absolute(tools[key]))) throw failure('SETUP_TOOLCHAIN_INVALID', 'Supply absolute nodePath, browserPath, ffmpegPath and ffprobePath values.');
  const identities = {} as SetupToolIdentities;
  for (const name of toolNames) {
    const path = tools[name], version = (await command(path, [name === 'ffmpegPath' || name === 'ffprobePath' ? '-version' : '--version'], { signal })).trim().split('\n')[0];
    const acceptable = name === 'nodePath' ? qualifiedNode(version)
      : name === 'browserPath' ? version.includes('156.0.8078.4')
      : version.startsWith(name === 'ffmpegPath' ? 'ffmpeg version ' : 'ffprobe version ');
    if (!acceptable) throw failure('SETUP_PREREQUISITE_UNQUALIFIED', `The selected ${name} is outside this release's qualified contract. Supply Node 24.22.1 or later on the 24 line, Chrome for Testing 156.0.8078.4 and working FFmpeg/ffprobe executables.`);
    identities[name] = { path, sha256: await digestFile(path), version };
  }
  return identities;
}
export async function observeSetupDoctor(voicesExecutable: string, options: { signal?: AbortSignal; provision?: CurrentAudioProvision; tools?: LocalTools } = {}): Promise<unknown> {
  const env = options.provision ? audioEnvironment(options.provision, runtimePaths().stateRoot, options.tools)
    : options.tools ? { HOME: homedir(), PATH: [...new Set([dirname(voicesExecutable), dirname(options.tools.nodePath), dirname(options.tools.ffmpegPath), dirname(options.tools.ffprobePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'), LANG: 'en_US.UTF-8', DO_NOT_TRACK: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' } : undefined;
  try { return JSON.parse(await command(voicesExecutable, ['--json', 'doctor'], { signal: options.signal, env })); }
  catch (error) { if (error instanceof Failure) throw error; throw failure('SETUP_VOICES_RESPONSE_INVALID', 'The selected Voices CLI must return its public JSON doctor contract. Resolve that installation before preparing setup.'); }
}

function validateCandidate(value: unknown): SetupCandidate {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== 'walkthrough-setup-candidate'
    || Object.keys(value).sort().join(',') !== 'audio,kind,license,previous,schemaVersion,targets,toolIdentities,tools'
    || !record(value.targets) || !same(value.targets, targets()) || !record(value.previous)
    || Object.keys(value.previous).sort().join(',') !== 'audio,license,receipt,toolchain'
    || Object.values(value.previous).some(item => item !== null && !digest(item)) || !record(value.tools) || !record(value.toolIdentities)
    || Object.keys(value.tools).sort().join(',') !== [...toolNames].sort().join(',')
    || Object.keys(value.toolIdentities).sort().join(',') !== [...toolNames].sort().join(',')) throw failure('SETUP_CANDIDATE_INVALID', 'Prepare a new setup candidate for this exact Walkthrough configuration and state root. The selected configuration remains unchanged.');
  for (const name of toolNames) {
    const identity = value.toolIdentities[name];
    if (!absolute(value.tools[name]) || !record(identity) || Object.keys(identity).sort().join(',') !== 'path,sha256,version'
      || identity.path !== value.tools[name] || !digest(identity.sha256) || typeof identity.version !== 'string' || !identity.version || identity.version.length > 4096) throw failure('SETUP_CANDIDATE_INVALID', 'The candidate has invalid prerequisite identities. Prepare a new candidate.');
  }
  const audio = validateAudioProvision(value.audio), license = validateLicenseAssertion(value.license);
  if (audio.schemaVersion !== 3 || audio.cacheDirectory !== runtimePaths().audioCacheDirectory || license.schemaVersion !== 2) throw failure('SETUP_CANDIDATE_INVALID', 'New setup requires a current audio manifest and explicit operator license assertion. Historical audio remains readable without conversion.');
  return value as unknown as SetupCandidate;
}
async function candidateAt(path: string, expectedDigest: string) {
  if (!absolute(path) || !digest(expectedDigest)) throw failure('SETUP_CANDIDATE_DIGEST_REQUIRED', 'Supply the absolute candidate path and exact SHA-256 returned by setup prepare.');
  await assertPrivateFile(path);
  if ((await lstat(path)).size > 8 * 1024 * 1024) throw failure('SETUP_CANDIDATE_INVALID', 'Use the bounded candidate returned by setup prepare. No selection was changed.');
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedDigest) throw failure('SETUP_CANDIDATE_CHANGED', 'The candidate bytes differ from the reviewed digest. Inspect them or prepare a new candidate; nothing was selected.');
  return validateCandidate(JSON.parse(bytes.toString('utf8')));
}

async function prepare(input: SetupPrepareInput, dependencies: SetupDependencies) {
  if (!absolute(input.candidatePath) || Object.values(targets()).includes(input.candidatePath) || input.candidatePath === setupPendingPath()) throw failure('SETUP_NEW_CANDIDATE_PATH_REQUIRED', 'Supply a new absolute candidate path outside the selected setup records.');
  if (await fingerprint(setupPendingPath()) !== null) throw failure('SETUP_APPLY_PENDING', 'Use setup inspect and rejoin the original setup apply before preparing a replacement.');
  const license = validateLicenseAssertion(input.license);
  if (license.schemaVersion !== 2) throw failure('SETUP_LICENSE_ASSERTION_REQUIRED', 'Record the operator’s explicit license basis using the current setup schema; never infer it from another operator’s assertion.');
  const tools = input.tools ?? resolveLocalTools(), toolIdentities = await dependencies.inspectTools(tools, input.signal);
  const doctor = await dependencies.observeDoctor(input.voicesExecutable, { signal: input.signal, tools });
  const audio = await dependencies.prepareAudio({ doctor, voicesExecutable: input.voicesExecutable, cacheDirectory: runtimePaths().audioCacheDirectory, defaultVoiceId: input.defaultVoiceId, voiceIds: input.voiceIds });
  await privateDirectory(runtimePaths().audioCacheDirectory);
  await verifyAudioProvision(audio);
  input.signal?.throwIfAborted();
  const destination = targets(), previous = {} as SetupCandidate['previous'];
  for (const name of Object.keys(destination) as (keyof SetupTargets)[]) previous[name] = await fingerprint(destination[name]);
  const candidate = validateCandidate({ schemaVersion: 1, kind: 'walkthrough-setup-candidate', targets: destination, previous, tools, toolIdentities, audio, license });
  await privateDirectory(dirname(input.candidatePath));
  try { await writeNew(input.candidatePath, candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw failure('SETUP_CANDIDATE_EXISTS', 'Choose a new candidate path. Existing candidate and selected setup records were not replaced.'); throw error; }
  return { schemaVersion: 1, status: 'prepared' as const, candidatePath: input.candidatePath, candidateSha256: await digestFile(input.candidatePath),
    targets: destination, tools: toolIdentities, audio: { voices: provisionVoices(audio).map(voice => voice.id), defaultVoiceId: defaultVoiceId(audio), voicesVersion: audio.runtime.voices_version, sourceSha256: audio.runtime.source_sha256 }, license,
    selected: false, downloads: false, inference: false, nextStep: 'Review this exact candidate, then use setup apply with candidatePath and candidateSha256.' };
}
export async function setupPrepare(input: SetupPrepareInput, dependencies: SetupDependencies = defaults) {
  try { return await prepare(input, dependencies); }
  catch (error) {
    if (error instanceof Failure) throw error;
    const code = error instanceof Error && /^(?:AUDIO_|LICENSE_)[A-Z_]+$/.test(error.message) ? error.message : input.signal?.aborted ? 'SETUP_PREPARE_ABORTED' : 'SETUP_PREPARE_FAILED';
    throw failure(code, 'No setup was selected. Inspect the chosen Voices CLI, saved voice and already-installed model snapshots, correct the named prerequisite, then prepare a new candidate. Setup never downloads or repairs shared assets.');
  }
}

async function assertNoOtherActivity(): Promise<void> {
  const { activeRoot } = runtimePaths();
  let names: string[];
  try { names = await readdir(activeRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names) {
    const path = join(activeRoot, name);
    await assertPrivateFile(path);
    let value: unknown; try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw failure('SETUP_ACTIVITY_UNRESOLVED', 'Inspect and settle the original runtime activity before selecting setup.'); }
    if (!record(value) || value.schemaVersion !== 1 || !['command', 'session'].includes(String(value.kind)) || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1) throw failure('SETUP_ACTIVITY_UNRESOLVED', 'Inspect and settle the original runtime activity before selecting setup.');
    if (value.kind === 'command' && (value.pid === process.pid || value.coordinatorPid === process.pid)) continue;
    if (value.kind === 'session' && value.status !== 'closed') throw failure('SETUP_ACTIVE_WORK', 'Close or recover the original session before changing selected tools or audio.');
    const groups = value.processGroupIds ?? [], pids = [value.pid, ...(value.coordinatorPid ? [value.coordinatorPid] : [])];
    if (!Array.isArray(groups) || [...groups, ...pids].some(pid => !Number.isSafeInteger(pid) || (pid as number) < 1)) throw failure('SETUP_ACTIVITY_UNRESOLVED', 'The retained activity has invalid process identities. Resolve its original operation.');
    for (const pid of [...pids as number[], ...(groups as number[]).map(pid => -pid)]) {
      try { process.kill(pid, 0); throw failure('SETUP_ACTIVE_WORK', 'Let other commands settle and close active sessions before applying setup.'); }
      catch (error) { if (error instanceof Failure) throw error; if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw failure('SETUP_ACTIVITY_UNRESOLVED', 'The original activity cannot be proven stopped. Inspect it before changing setup.'); }
    }
  }
}
function outputsFor(candidate: SetupCandidate, candidatePath: string, candidateSha256: string): SetupOutput[] {
  const toolchain = { schemaVersion: 1, tools: candidate.tools };
  const receipt: SetupReceipt = { schemaVersion: 1, kind: 'walkthrough-setup-selection', candidatePath, candidateSha256,
    toolIdentities: candidate.toolIdentities, audioSha256: sha256(encode(candidate.audio)), licenseSha256: sha256(encode(candidate.license)) };
  return ([['toolchain', toolchain], ['audio', candidate.audio], ['license', candidate.license], ['receipt', receipt]] as const)
    .map(([key, value]) => ({ path: candidate.targets[key], temporary: `${candidate.targets[key]}.setup-${candidateSha256}.next`, before: candidate.previous[key], after: sha256(encode(value)), value }));
}
type SetupApplyInput = { candidatePath: string; candidateSha256: string; signal?: AbortSignal };
async function apply(input: SetupApplyInput, dependencies: SetupDependencies) {
  const candidate = await candidateAt(input.candidatePath, input.candidateSha256), outputs = outputsFor(candidate, input.candidatePath, input.candidateSha256);
  let pending: SetupPending | null = null;
  if (await fingerprint(setupPendingPath()) !== null) {
    pending = JSON.parse(await readFile(setupPendingPath(), 'utf8'));
    if (!pending || pending.schemaVersion !== 1 || pending.kind !== 'walkthrough-setup-apply' || !Number.isSafeInteger(pending.pid) || pending.pid < 1 || pending.candidatePath !== input.candidatePath || pending.candidateSha256 !== input.candidateSha256 || !same(pending.outputs, outputs)) throw failure('SETUP_APPLY_PENDING', 'Use setup inspect to find and rejoin the existing candidate. A different setup may not replace an interrupted selection.');
  }
  await assertNoOtherActivity();
  const current = await Promise.all(outputs.map(output => fingerprint(output.path)));
  const alreadySelected = !pending && current.every((value, i) => value === outputs[i].after);
  if (!alreadySelected && current.some((value, i) => value !== outputs[i].before && (!pending || value !== outputs[i].after))) throw failure('SETUP_SELECTION_CHANGED', 'Selected setup changed after preparation. Preserve the candidate and prepare another against the current selection; no changed record was overwritten.');
  if (!same(await dependencies.inspectTools(candidate.tools, input.signal), candidate.toolIdentities)) throw failure('SETUP_PREREQUISITE_CHANGED', 'A selected prerequisite changed after preparation. Prepare a new candidate against its actual installed identity.');
  await verifyAudioProvision(candidate.audio);
  const doctor = await dependencies.observeDoctor(candidate.audio.voicesExecutable, { signal: input.signal, provision: candidate.audio, tools: candidate.tools });
  if (!record(doctor) || !same(validateAudioProvision({ ...candidate.audio, runtime: doctor.runtime }).runtime, candidate.audio.runtime)
    || !record(doctor.library) || candidate.audio.voices.some(voice => voice.libraryPath !== (doctor.library as Record<string, unknown>).path)
    || doctor.model_cache !== candidate.audio.hubCacheDirectory || !record(doctor.models) || !record(doctor.model_revisions)
    || (['tts', 'aligner', 'asr'] as const).some(role => {
      const key = role === 'tts' ? 'base' : role === 'asr' ? 'stt' : 'aligner';
      return (doctor.models as Record<string, unknown>)[key] !== candidate.audio.models[role].repository
        || (doctor.model_revisions as Record<string, unknown>)[key] !== candidate.audio.models[role].revision;
    })) throw failure('SETUP_VOICES_CHANGED', 'Voices changed after preparation. Inspect its current public runtime and prepare a new candidate; do not accept an upgrade silently.');
  input.signal?.throwIfAborted();
  if (alreadySelected) return { schemaVersion: 1, status: 'applied' as const, changed: false, candidatePath: input.candidatePath, candidateSha256: input.candidateSha256, downloads: false, inference: false };
  for (const output of outputs) await privateDirectory(dirname(output.path));
  if (!pending) {
    for (const temporary of [...outputs.map(output => output.temporary), journalTemporary(input.candidateSha256)]) {
      if (await fingerprint(temporary) !== null) throw failure('SETUP_SCRATCH_EXISTS', 'An unowned setup scratch slot already exists. Preserve it and inspect its original owner; no selection was started or foreign file removed.');
    }
    pending = { schemaVersion: 1, kind: 'walkthrough-setup-apply', candidatePath: input.candidatePath, candidateSha256: input.candidateSha256, pid: process.pid, outputs };
    try { await writeNew(setupPendingPath(), pending); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw failure('SETUP_APPLY_PENDING', 'Another setup apply acquired selection. Inspect its exact candidate before continuing.'); throw error; }
  } else {
    if (pending.pid !== process.pid) { try { process.kill(pending.pid, 0); throw failure('SETUP_APPLY_RUNNING', 'The original setup process is still present. Let it settle rather than running a concurrent apply.'); } catch (error) { if (error instanceof Failure) throw error; if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw failure('SETUP_APPLY_UNRESOLVED', applyAgain(input.candidatePath, input.candidateSha256)); } }
    const before = await fingerprint(setupPendingPath());
    pending.pid = process.pid; await replaceJson(setupPendingPath(), pending, journalTemporary(input.candidateSha256), before);
  }
  try {
    await assertNoOtherActivity();
    for (const output of outputs) {
      input.signal?.throwIfAborted();
      const before = await fingerprint(output.path);
      if (before === output.after) { await removeScratch(output.temporary); continue; }
      if (before !== output.before) throw failure('SETUP_SELECTION_CHANGED', applyAgain(input.candidatePath, input.candidateSha256));
      await replaceJson(output.path, output.value, output.temporary, before);
    }
    if ((await Promise.all(outputs.map(output => fingerprint(output.path)))).some((value, i) => value !== outputs[i].after)) throw failure('SETUP_SELECTION_CHANGED', applyAgain(input.candidatePath, input.candidateSha256));
    await rm(setupPendingPath());
  } catch (error) { throw failure(error instanceof Failure ? error.code : 'SETUP_APPLY_INTERRUPTED', applyAgain(input.candidatePath, input.candidateSha256)); }
  return { schemaVersion: 1, status: 'applied' as const, changed: true, candidatePath: input.candidatePath, candidateSha256: input.candidateSha256,
    defaultVoiceId: candidate.audio.defaultVoiceId, targets: candidate.targets, downloads: false, inference: false, nextStep: 'Use setup inspect to verify selected readiness. Historical projects and retained audio were not changed.' };
}
export async function setupApply(input: SetupApplyInput, dependencies: SetupDependencies = defaults) {
  try { return await apply(input, dependencies); }
  catch (error) {
    if (error instanceof Failure) throw error;
    const code = error instanceof Error && /^(?:AUDIO_|LICENSE_)[A-Z_]+$/.test(error.message) ? error.message : input.signal?.aborted ? 'SETUP_APPLY_ABORTED' : 'SETUP_APPLY_FAILED';
    throw failure(code, `Use setup inspect to see the surviving selection. Correct the named installed prerequisite without changing shared assets automatically. ${applyAgain(input.candidatePath, input.candidateSha256)}`);
  }
}

/** Readiness is independent of project/media availability and never mutates
 * selected setup, loads a model or asserts license eligibility for the caller. */
export async function setupInspect(options: { signal?: AbortSignal } = {}, dependencies: SetupDependencies = defaults) {
  const destination = targets(), checks: Array<{ id: string; status: 'ready' | 'missing' | 'invalid' | 'changed' | 'unavailable'; code?: string; nextStep?: string }> = [];
  let pending: Pick<SetupPending, 'candidatePath' | 'candidateSha256' | 'pid'> | null = null;
  try {
    if (await fingerprint(setupPendingPath()) !== null) {
      const value = JSON.parse(await readFile(setupPendingPath(), 'utf8'));
      if (value.kind !== 'walkthrough-setup-apply' || !absolute(value.candidatePath) || !digest(value.candidateSha256) || !Number.isSafeInteger(value.pid) || value.pid < 1) throw Error();
      pending = { candidatePath: value.candidatePath, candidateSha256: value.candidateSha256, pid: value.pid };
    }
  } catch { checks.push({ id: 'pending-selection', status: 'invalid', code: 'SETUP_APPLY_UNRESOLVED', nextStep: 'Preserve and inspect the exact setup-pending.json record before changing configuration.' }); }
  let receipt: SetupReceipt | null = null;
  try {
    if (await fingerprint(destination.receipt) !== null) receipt = JSON.parse(await readFile(destination.receipt, 'utf8'));
    if (receipt && (receipt.schemaVersion !== 1 || receipt.kind !== 'walkthrough-setup-selection' || !absolute(receipt.candidatePath) || !digest(receipt.candidateSha256)
      || !digest(receipt.audioSha256) || !digest(receipt.licenseSha256) || !record(receipt.toolIdentities))) throw Error();
  } catch { checks.push({ id: 'setup-selection', status: 'invalid', code: 'SETUP_SELECTION_INVALID', nextStep: 'Prepare a new reviewed candidate from the installed prerequisites.' }); }
  let tools: LocalTools | null = null;
  try {
    tools = resolveLocalTools();
    const identities = await dependencies.inspectTools(tools, options.signal);
    checks.push({ id: 'prerequisites', status: receipt && !same(identities, receipt.toolIdentities) ? 'changed' : 'ready', ...(receipt && !same(identities, receipt.toolIdentities) ? { code: 'SETUP_PREREQUISITE_CHANGED', nextStep: 'Prepare and apply a reviewed candidate for the actual installed prerequisite identities.' } : {}) });
  } catch (error) { checks.push({ id: 'prerequisites', status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', code: error instanceof Failure ? error.code : 'SETUP_PREREQUISITE_UNAVAILABLE', nextStep: 'Install or explicitly select the required Node, browser, FFmpeg and ffprobe, then prepare setup.' }); }
  for (const [id, path] of [['toolchain', destination.toolchain], ['audio-configuration', destination.audio], ['license-configuration', destination.license]] as const) {
    try {
      const observed = await fingerprint(path), expected = id === 'audio-configuration' ? receipt?.audioSha256 : id === 'license-configuration' ? receipt?.licenseSha256 : null;
      if (observed !== null) {
        if (id === 'toolchain') readToolchainSelection();
        else if (id === 'audio-configuration') validateAudioProvision(JSON.parse(await readFile(path, 'utf8')));
        else validateLicenseAssertion(JSON.parse(await readFile(path, 'utf8')));
      }
      checks.push({ id, status: observed === null ? 'missing' : expected && observed !== expected ? 'changed' : 'ready', nextStep: 'Use setup prepare and apply to select reviewed configuration.' });
    }
    catch { checks.push({ id, status: 'invalid', code: 'SETUP_CONFIGURATION_INVALID', nextStep: 'Preserve the unexpected record and resolve its ownership before preparing setup.' }); }
  }
  const audio = await inspectAudioReadiness(destination.audio, { signal: options.signal });
  checks.push({ id: 'audio-runtime', status: audio.status === 'provisioned' ? 'ready' : audio.status === 'runtime-drift' ? 'changed' : audio.status === 'missing' ? 'missing' : audio.status === 'invalid' || audio.status === 'legacy-provision' ? 'invalid' : 'unavailable',
    ...(audio.status !== 'provisioned' ? { code: `AUDIO_${audio.status.toUpperCase().replaceAll('-', '_')}`, nextStep: 'Inspect the installed Voices doctor and saved voices; prepare and apply an explicit candidate. No model download is performed by setup.' } : {}) });
  try { await verifyLicense(destination.license); checks.push({ id: 'operator-license', status: 'ready' }); }
  catch { checks.push({ id: 'operator-license', status: checks.find(check => check.id === 'license-configuration')?.status === 'missing' ? 'missing' : 'invalid', code: 'LICENSE_ELIGIBILITY_NOT_PROVISIONED', nextStep: 'Ask the operator for the applicable Remotion 4.0.538 license basis; do not infer it.' }); }
  return { schemaVersion: 1, status: pending || checks.some(check => check.status !== 'ready') ? 'not-ready' as const : 'ready' as const,
    targets: destination, tools, audio, checks, pending, downloads: false, inference: false,
    nextStep: pending ? applyAgain(pending.candidatePath, pending.candidateSha256) : checks.every(check => check.status === 'ready') ? 'Setup is selected. Use doctor for the capture or compose prerequisites.' : 'Resolve the named prerequisite or configuration, then prepare and apply a reviewed setup candidate.' };
}
