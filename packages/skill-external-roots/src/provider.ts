/**
 * `ExternalRootsProvider`: a `SkillProvider` for the `ctx.skills` registry
 * that mounts skills already present in external agent tool roots (OpenAI
 * Codex `~/.codex/skills`, Claude Code `~/.claude/skills`, Cursor
 * `~/.cursor/skills*`, OpenCode `~/.config/opencode/skills`, and — only when
 * explicitly enabled — `~/.agents/skills`). It reuses the official local
 * filesystem discovery rules (directory bundles `<kebab>/SKILL.md`, flat
 * `<kebab>.md`, YAML frontmatter requiring `name` + `description`) so skills
 * written for those tools are directly callable by the dsh model.
 *
 * Every candidate is tagged `source: 'external'` and ranked
 * {@link EXTERNAL_ROOTS_DEFAULT_RANK} (350) — after project skills (100/200)
 * and before user skills (400/500) — under the provider name
 * {@link EXTERNAL_ROOTS_DEFAULT_PROVIDER_NAME}. A chokidar watcher per
 * existing root invalidates the registry on direct-child changes (the
 * `watch: false` escape hatch disables it).
 *
 * @module @dsh-plugins/skill-external-roots/provider
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { unwatchFile, watchFile } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { parse as parseYaml } from 'yaml'
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
  type SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import type { ExternalRootProbe, ExternalSkillLocator } from './types.ts'

/** Source bucket every candidate from this provider carries (prompt-visible). */
export const EXTERNAL_SOURCE = 'external'

/** Default provider name in the `ctx.skills` registry (a distinct layer from `filesystem`). */
export const EXTERNAL_ROOTS_DEFAULT_PROVIDER_NAME = 'external-roots'

/**
 * Default rank: after project roots (100/200), before user roots (400/500),
 * on the same tier the official custom root (300) uses with a lower number so
 * a plugin-provided external root shadows a configured custom root.
 */
export const EXTERNAL_ROOTS_DEFAULT_RANK = 350

/** Milliseconds a changed entry must stay stable before chokidar reports it. */
const DEFAULT_WATCH_STABILITY_THRESHOLD_MS = 200
/** Milliseconds between chokidar stability or polling probes. */
const DEFAULT_WATCH_POLL_INTERVAL_MS = 100

/**
 * Fully-resolved provider options. The plugin's `apply` supplies every
 * default (Config schema defaults + code fallbacks); each field here is
 * authoritative for one provider instance. `home` / `agentsHome` /
 * `watchUsePolling` / `watchStabilityThresholdMs` / `watchPollIntervalMs`
 * are injectable for tests and deployment overrides; the plugin Config does
 * not expose them (v1 keeps the surface per development-plan §4.2).
 */
export interface ExternalRootsProviderOptions {
  /** Unique provider name in the registry. */
  readonly providerName: string
  /** Per-tool family switch; a disabled family is never probed. */
  readonly enabled: { readonly codex: boolean; readonly claude: boolean; readonly cursor: boolean; readonly opencode: boolean }
  /** Extra roots scanned after the defaults, in order. */
  readonly customDirs: readonly string[]
  /** Explicitly mount `~/.agents/skills` (the built-in filesystem provider already covers it). */
  readonly agentsRoot: boolean
  /** Candidate rank; defaults to 350. */
  readonly rank: number
  /** Skill names to drop from the catalog. */
  readonly exclude: readonly string[]
  /** Whether chokidar invalidates the registry on root-directory changes. */
  readonly watch: boolean
  /** Home directory used to resolve default roots; defaults to `os.homedir()`. */
  readonly home?: string
  /** Agents home used for `agentsRoot`; defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  readonly agentsHome?: string
  /** Test/deployment override: chokidar polling instead of native events. */
  readonly watchUsePolling?: boolean
  /** Test/deployment override: `awaitWriteFinish` stability threshold. */
  readonly watchStabilityThresholdMs?: number
  /** Test/deployment override: chokidar probe interval. */
  readonly watchPollIntervalMs?: number
}

/** One probed root candidate: its absolute path and whether it is a directory. */
export interface ExternalRootCandidate {
  readonly path: string
  readonly exists: boolean
}

/** A skill fully parsed from frontmatter plus body. */
export interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly content: string
}

/** Parse outcome: the skill, or the machine-readable reason it was skipped. */
export type SkillParseOutcome =
  | { readonly ok: true; readonly skill: ParsedSkill }
  | { readonly ok: false; readonly reason: string }

/**
 * Mutable per-instance scan state recorded by the provider and read by the
 * `./invariant` companion. Records the package's data relation: which roots
 * exist and which candidate paths each scan produced.
 */
export class ExternalRootsHealth {
  private readonly probes = new Map<string, ExternalRootProbe>()

  /** Record one root's latest scan. */
  record(probe: ExternalRootProbe): void {
    this.probes.set(probe.root, probe)
  }

  /** All recorded probes, in scan order. */
  snapshot(): readonly ExternalRootProbe[] {
    return [...this.probes.values()]
  }

  /** Forget every probe (a fresh plugin instance starts clean). */
  clear(): void {
    this.probes.clear()
  }
}

let currentHealth: ExternalRootsHealth | undefined

/** Point the package health singleton at one plugin instance's state. */
export function registerExternalRootsHealth(health: ExternalRootsHealth): void {
  currentHealth = health
}

/** The currently registered plugin instance's health, if any. */
export function externalRootsHealth(): ExternalRootsHealth | undefined {
  return currentHealth
}

/**
 * Resolve the default root candidate paths for the enabled tool families,
 * in scan order (codex → claude → cursor → opencode → agents → customDirs).
 * Cursor candidates are the exact paths probed — never a wildcard expansion.
 * A family may contribute several candidates; existence is probed separately
 * and non-existent roots are silently skipped by the provider.
 *
 * @param home - home directory for the per-tool roots.
 * @param agentsHome - agents home used when `agentsRoot` is on.
 * @param enabled - per-tool switches.
 * @param agentsRoot - whether to append the agents root.
 * @param customDirs - extra roots appended after the defaults.
 * @returns the ordered candidate root paths.
 */
export function defaultRootCandidates(
  home: string,
  agentsHome: string,
  enabled: { readonly codex: boolean; readonly claude: boolean; readonly cursor: boolean; readonly opencode: boolean },
  agentsRoot: boolean,
  customDirs: readonly string[],
): string[] {
  const paths: string[] = []
  if (enabled.codex) paths.push(join(home, '.codex', 'skills'))
  if (enabled.claude) paths.push(join(home, '.claude', 'skills'))
  if (enabled.cursor) {
    // Cursor has no single standard global skills path; probe the exact
    // candidates below (never expand a wildcard) and mount only what exists.
    paths.push(join(home, '.cursor', 'skills'))
    paths.push(join(home, '.cursor', 'skills-cursor'))
  }
  if (enabled.opencode) paths.push(join(home, '.config', 'opencode', 'skills'))
  if (agentsRoot) paths.push(join(agentsHome, 'skills'))
  paths.push(...customDirs)
  return paths
}

/**
 * Parse one skill file's text with the official local-provider frontmatter
 * rules: a `---`-delimited YAML block whose mapping carries a kebab-case
 * `name` and a non-blank `description`; optional `whenToUse`,
 * `disable-model-invocation`, `user-invocable`, and `metadata`. Unknown keys
 * (Cursor `environments`, Codex `license`, ...) are ignored. Returns a
 * machine-readable skip reason instead of throwing.
 *
 * @param raw - the full skill file text.
 * @returns the parsed skill, or the skip reason.
 */
export function parseExternalSkill(raw: string): SkillParseOutcome {
  const frontmatter = parseFrontmatter(raw)
  if (frontmatter === undefined) {
    return { ok: false, reason: 'missing YAML frontmatter' }
  }
  let data: Record<string, unknown>
  try {
    const parsed = parseYaml(frontmatter.yaml) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'frontmatter is not a YAML mapping' }
    }
    data = parsed as Record<string, unknown>
  } catch (error) {
    return { ok: false, reason: `invalid YAML frontmatter: ${errorMessage(error)}` }
  }
  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (name === undefined || description === undefined) {
    return { ok: false, reason: 'frontmatter requires name and description' }
  }
  if (!isSkillName(name)) {
    return { ok: false, reason: `invalid skill name "${name}"` }
  }
  let modelInvocable: boolean
  let userInvocable: boolean
  try {
    modelInvocable = frontmatterBoolean(data, 'disable-model-invocation') !== true
    userInvocable = frontmatterBoolean(data, 'user-invocable') !== false
  } catch (error) {
    return { ok: false, reason: `invalid invocation frontmatter: ${errorMessage(error)}` }
  }
  return {
    ok: true,
    skill: {
      name,
      description,
      ...optionalString(data, 'whenToUse'),
      modelInvocable,
      userInvocable,
      ...optionalMetadata(data),
      content: frontmatter.body.trim(),
    },
  }
}

/** Whether a candidate path lies strictly inside a root directory. */
export function pathInsideRoot(root: string, path: string): boolean {
  const child = relative(root, path)
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** The provider that maps external tool roots into `ctx.skills`. */
export class ExternalRootsProvider implements SkillProvider {
  readonly name: string
  private readonly home: string
  private readonly agentsHome: string
  private readonly watchManager: ExternalRootsWatchManager
  private disposal: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    control: SkillProviderControl,
    private readonly options: ExternalRootsProviderOptions,
    private readonly health: ExternalRootsHealth,
  ) {
    this.name = options.providerName
    this.home = options.home ?? homedir()
    this.agentsHome = resolve(options.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
    this.watchManager = new ExternalRootsWatchManager(ctx, control.invalidate, {
      enabled: options.watch,
      usePolling: options.watchUsePolling ?? false,
      stabilityThresholdMs: options.watchStabilityThresholdMs ?? DEFAULT_WATCH_STABILITY_THRESHOLD_MS,
      pollIntervalMs: options.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS,
    })
    control.signal.addEventListener('abort', () => { void this.dispose() }, { once: true })
  }

  /**
   * Discover external skills for the enabled, existing roots. Non-existent
   * roots are skipped silently; a root that exists but cannot be scanned
   * marks the observation incomplete so the registry keeps last-good state.
   * @param options - lookup options whose signal cancels filesystem reads.
   * @returns candidates, or an explicit incomplete observation.
   */
  async list(options: SkillLookupOptions): Promise<SkillCandidate[] | SkillProviderObservation> {
    options.signal?.throwIfAborted()
    const roots = await this.resolveRoots()
    let complete = true
    try {
      await this.watchManager.observe(roots)
    } catch (error) {
      if (this.disposal !== undefined) throw error
      complete = false
    }
    const candidates: SkillCandidate[] = []
    const scannedAt = Date.now()
    for (const root of roots) {
      if (!root.exists) {
        this.health.record({ root: root.path, exists: false, candidates: [], scannedAt })
        continue
      }
      try {
        const scanned = await this.scanRoot(root.path, options.signal)
        this.health.record({ root: root.path, exists: true, candidates: scanned.candidatePaths, scannedAt })
        candidates.push(...scanned.candidates)
      } catch (error) {
        this.ctx.logger.warn(`skill-external-roots: failed to scan root ${root.path}: ${errorMessage(error)}`)
        complete = false
        this.health.record({ root: root.path, exists: true, candidates: [], scannedAt })
      }
    }
    return complete ? candidates : { candidates, complete }
  }

  /**
   * Re-read a previously listed candidate's body and return the full
   * definition. A file that vanished or whose frontmatter `name` no longer
   * matches the candidate is rejected (`undefined`), which makes the registry
   * invalidate the stale entry and rediscover.
   * @param candidate - the winning candidate returned by this provider.
   * @param options - lookup options whose signal cancels the read.
   * @returns the full definition, or `undefined` when no longer loadable.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as ExternalSkillLocator
    options.signal?.throwIfAborted()
    let raw: string
    try {
      raw = await readFile(locator.path, { encoding: 'utf8', signal: options.signal })
    } catch (error) {
      options.signal?.throwIfAborted()
      if (isAbsentPathError(error)) return undefined
      throw error
    }
    options.signal?.throwIfAborted()
    const outcome = parseExternalSkill(raw)
    if (!outcome.ok) return undefined
    const skill = outcome.skill
    if (skill.name !== candidate.name) return undefined
    return {
      name: skill.name,
      description: skill.description,
      ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
      invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
      source: candidate.source,
      provider: this.options.providerName,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
      content: skill.content,
    }
  }

  /**
   * Close every host watcher and contain late filesystem callbacks.
   * @returns a shared promise settling when every watcher is closed.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.watchManager.dispose()
    return this.disposal
  }

  private async resolveRoots(): Promise<ExternalRootCandidate[]> {
    const paths = defaultRootCandidates(
      this.home,
      this.agentsHome,
      this.options.enabled,
      this.options.agentsRoot,
      this.options.customDirs,
    )
    const roots: ExternalRootCandidate[] = []
    for (const path of paths) {
      let exists = false
      try {
        exists = await pathIsDirectory(path)
      } catch (error) {
        // A non-absent stat failure only costs this candidate root.
        this.ctx.logger.warn(`skill-external-roots: failed to probe root ${path}: ${errorMessage(error)}`)
      }
      roots.push({ path, exists })
    }
    return roots
  }

  private async scanRoot(
    root: string,
    signal: AbortSignal | undefined,
  ): Promise<{ candidates: SkillCandidate[]; candidatePaths: string[] }> {
    signal?.throwIfAborted()
    let entries: Dirent[]
    try {
      entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      // The root vanished between the probe and the scan: an empty result.
      if (isAbsentPathError(error)) return { candidates: [], candidatePaths: [] }
      throw error
    }
    const candidates: SkillCandidate[] = []
    const candidatePaths: string[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // `.system` is the tools' own internal skills bucket (Codex ships
      // `review-agent`, `skill-creator`, ... there); the user's personal
      // skills live beside it and are the ones this plugin mounts.
      if (entry.name === '.system') continue
      signal?.throwIfAborted()
      const kind = await entryKind(join(root, entry.name), entry, this.ctx)
      const locator: ExternalSkillLocator | undefined = kind === 'directory'
        ? { path: join(root, entry.name, 'SKILL.md'), directory: join(root, entry.name) }
        : kind === 'file' && entry.name.endsWith('.md')
          ? { path: join(root, entry.name), directory: root }
          : undefined
      if (locator === undefined) continue
      let raw: string
      try {
        raw = await readFile(locator.path, { encoding: 'utf8', signal })
      } catch (error) {
        signal?.throwIfAborted()
        if (isAbsentPathError(error)) continue
        throw error
      }
      signal?.throwIfAborted()
      const outcome = parseExternalSkill(raw)
      if (!outcome.ok) {
        this.ctx.logger.warn(`skill-external-roots: ${locator.path} ignored: ${outcome.reason}`)
        continue
      }
      const skill = outcome.skill
      if (this.options.exclude.includes(skill.name)) continue
      candidates.push({
        name: skill.name,
        description: skill.description,
        ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
        invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
        provider: this.options.providerName,
        source: EXTERNAL_SOURCE,
        rank: this.options.rank,
        locator,
        resourceBase: { kind: 'directory', path: locator.directory },
        path: locator.path,
        ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
      })
      candidatePaths.push(locator.path)
    }
    return { candidates, candidatePaths }
  }
}

type SkillWatchEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'

interface WatchManagerConfig {
  enabled: boolean
  usePolling: boolean
  stabilityThresholdMs: number
  pollIntervalMs: number
}

interface RootWatchState {
  watcher: FSWatcher | undefined
  opening: Promise<void> | undefined
}

interface AncestorPollState {
  nextPath: string
  listener: () => void
}

/**
 * Owns one chokidar watcher per existing root plus a Node `watchFile` poll on
 * the nearest missing path segment for roots that do not exist yet. Every
 * relevant direct-child change (or the appearance of a missing root) funnels
 * into the registration's `invalidate()`, coalesced per microtask.
 */
class ExternalRootsWatchManager {
  private readonly watchers = new Map<string, RootWatchState>()
  private readonly ancestorPolls = new Map<string, AncestorPollState>()
  private readonly lifecycle = new AbortController()
  private closing = false
  private invalidationQueued = false

  constructor(
    private readonly ctx: Context,
    private readonly invalidate: () => void,
    private readonly config: WatchManagerConfig,
  ) {}

  /** Reconcile watchers with the current root set: open for new roots, close stale ones. */
  async observe(roots: readonly ExternalRootCandidate[]): Promise<void> {
    if (this.closing || !this.config.enabled) return
    const current = new Set(roots.map(root => root.path))
    for (const path of [...this.watchers.keys()]) {
      if (!current.has(path)) {
        const state = this.watchers.get(path)
        this.watchers.delete(path)
        if (state?.watcher !== undefined) await this.closeWatcher(state.watcher)
      }
    }
    for (const path of [...this.ancestorPolls.keys()]) {
      if (!current.has(path)) this.releaseAncestorPoll(path)
    }
    await Promise.all(roots.map(async (root) => {
      if (root.exists) {
        this.releaseAncestorPoll(root.path)
        await this.ensureRootWatcher(root.path)
      } else {
        await this.ensureAncestorPoll(root.path)
      }
    }))
  }

  /** Close every watcher and poll; safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.lifecycle.abort(new Error('skill-external-roots watcher disposed'))
    const watchers = [...this.watchers.values()]
    this.watchers.clear()
    for (const state of watchers) {
      if (state.watcher !== undefined) await this.closeWatcher(state.watcher)
    }
    for (const poll of this.ancestorPolls.values()) {
      unwatchFile(poll.nextPath, poll.listener)
    }
    this.ancestorPolls.clear()
  }

  private async ensureRootWatcher(root: string): Promise<void> {
    let state = this.watchers.get(root)
    if (state === undefined) {
      state = { watcher: undefined, opening: undefined }
      this.watchers.set(root, state)
    }
    if (state.watcher !== undefined || state.opening !== undefined) return
    const opening = this.openRootWatcher(root)
    // The tracked promise stays void and swallows the same rejection the
    // await below handles, so an unhandled-rejection never escapes teardown.
    state.opening = opening.then(() => {}, () => {})
    try {
      const watcher = await opening
      if (this.closing) {
        await this.closeWatcher(watcher)
        return
      }
      const current = this.watchers.get(root)
      if (current === undefined) {
        await this.closeWatcher(watcher)
        return
      }
      current.watcher = watcher
    } catch (error) {
      if (!this.closing) {
        this.ctx.logger.warn(`skill-external-roots: failed to watch ${root}: ${errorMessage(error)}`)
      }
    } finally {
      state.opening = undefined
    }
  }

  private async openRootWatcher(root: string): Promise<FSWatcher> {
    const watcher = chokidar.watch(root, {
      // Chokidar owns late native fs.watch errors only for persistent watchers;
      // dispose() explicitly closes every handle at teardown.
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      followSymlinks: true,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.stabilityThresholdMs,
        pollInterval: this.config.pollIntervalMs,
      },
      usePolling: this.config.usePolling,
      interval: this.config.pollIntervalMs,
    })
    for (const event of ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const) {
      watcher.on(event, (path: string) => { this.handleRootEvent(root, event, path) })
    }
    watcher.on('error', (error: unknown) => {
      if (this.closing) return
      this.ctx.logger.warn(`skill-external-roots: watcher for ${root} failed: ${errorMessage(error)}`)
      this.queueInvalidation()
    })
    const signal = this.lifecycle.signal
    if (signal.aborted) {
      await this.closeWatcher(watcher)
      signal.throwIfAborted()
    }
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => { cleanup(); resolve() }
      const onError = (error: unknown): void => { cleanup(); reject(error) }
      const onAbort = (): void => { cleanup(); reject(signal.reason) }
      const cleanup = (): void => {
        watcher.off('ready', onReady)
        watcher.off('error', onError)
        signal.removeEventListener('abort', onAbort)
      }
      watcher.once('ready', onReady)
      watcher.once('error', onError)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return watcher
  }

  private async ensureAncestorPoll(root: string): Promise<void> {
    if (this.ancestorPolls.has(root)) return
    const mode = await resolveRootWatchMode(root)
    if (mode === undefined || mode.kind === 'root') return
    const listener = (): void => { this.queueInvalidation() }
    watchFile(mode.nextPath, {
      persistent: false,
      interval: this.config.pollIntervalMs,
    }, listener)
    this.ancestorPolls.set(root, { nextPath: mode.nextPath, listener })
  }

  private releaseAncestorPoll(root: string): void {
    const poll = this.ancestorPolls.get(root)
    if (poll === undefined) return
    this.ancestorPolls.delete(root)
    unwatchFile(poll.nextPath, poll.listener)
  }

  private handleRootEvent(root: string, event: SkillWatchEvent, path: string): void {
    if (this.closing) return
    const segments = containedSegments(root, path)
    if (segments === undefined) return
    if (segments.length === 0) {
      if (event === 'addDir' || event === 'unlinkDir') this.queueInvalidation()
      return
    }
    if (segments[0] === '.system') return
    if (segments.length === 1) {
      if (event === 'addDir' || event === 'unlinkDir') {
        this.queueInvalidation()
        return
      }
      // A flat `.md` skill appearing, changing, or vanishing.
      if (segments[0]?.endsWith('.md') === true) this.queueInvalidation()
      return
    }
    // `<skill>/SKILL.md` body changes (add/change/unlink), not the dir itself.
    if (segments.length === 2 && segments[1] === 'SKILL.md' && event !== 'addDir' && event !== 'unlinkDir') {
      this.queueInvalidation()
    }
  }

  private queueInvalidation(): void {
    if (this.closing || this.invalidationQueued) return
    this.invalidationQueued = true
    queueMicrotask(() => {
      this.invalidationQueued = false
      if (this.closing) return
      this.invalidate()
    })
  }

  private async closeWatcher(watcher: FSWatcher): Promise<void> {
    try {
      await watcher.close()
    } catch (error) {
      this.ctx.logger.warn(`skill-external-roots: failed to close watcher: ${errorMessage(error)}`)
    }
  }
}

/**
 * Find the watch anchor for a root: the root itself when it is a directory,
 * otherwise the nearest existing ancestor with the first missing path segment
 * (so creating the root later still invalidates the catalog). `undefined`
 * means no existing ancestor was found at all.
 */
async function resolveRootWatchMode(
  root: string,
): Promise<{ kind: 'root' } | { kind: 'ancestor'; nextPath: string } | undefined> {
  let candidate = root
  while (true) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) {
        if (candidate === root) return { kind: 'root' }
        const firstSegment = relative(candidate, root).split(sep)[0]
        if (firstSegment === undefined || firstSegment.length === 0) return { kind: 'root' }
        return { kind: 'ancestor', nextPath: join(candidate, firstSegment) }
      }
    } catch {
      // Absent path: keep walking toward the filesystem root.
    }
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
}

/** Path segments of `path` under `root`, or `undefined` when outside it. */
function containedSegments(root: string, path: string): string[] | undefined {
  const child = relative(root, path)
  if (child.length === 0) return []
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined
  return child.split(sep)
}

async function pathIsDirectory(path: string): Promise<boolean> {
  const info = await stat(path)
  return info.isDirectory()
}

/** Classify a root entry, following symbolic links like the official provider. */
async function entryKind(fullPath: string, entry: Dirent, ctx: Context): Promise<'directory' | 'file' | undefined> {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink()) return undefined
  try {
    const info = await stat(fullPath)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return undefined
  } catch (error) {
    ctx.logger.warn(`skill-external-roots: entry ${fullPath} ignored: failed to follow symbolic link: ${errorMessage(error)}`)
    return undefined
  }
}

/** Split a skill file's `---`-delimited frontmatter; `undefined` when absent. */
function parseFrontmatter(raw: string): { yaml: string; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  return { yaml: raw.slice(start, closing.start), body: raw.slice(closing.bodyStart) }
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(data: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

/** Coerce the official boolean frontmatter grammar; throws on other types. */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function optionalMetadata(data: Record<string, unknown>): { metadata?: Readonly<Record<string, unknown>> } {
  const value = data.metadata
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { metadata: value as Record<string, unknown> }
  }
  return {}
}

function isAbsentPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return String(error)
}
