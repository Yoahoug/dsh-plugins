import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  EXTERNAL_SOURCE,
  defaultRootCandidates,
  parseExternalSkill,
  pathInsideRoot,
  ExternalRootsHealth,
  ExternalRootsProvider,
  registerExternalRootsHealth,
} from '../src/provider.ts'
import type { ExternalRootsProviderOptions } from '../src/provider.ts'
import { checkExternalRootsHealth } from '../src/invariant.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as invariantPlugin from '../src/invariant.ts'

const clean = (text: string): string => text.trim()

/** Real OpenAI Codex skill head (as shipped on this machine). */
const CODEX_HEAD = `---
name: gh-private-exe-release
description: 接单/交付类 Python 桌面项目走「私有 GitHub 仓 + Windows EXE + 版本号 Releases」的标准交付流程。在 Mac 上开发、用 GitHub Actions 打 Windows 单文件 exe，按 vX.Y.Z 标签发布到 Releases，最终只给用户下载网页地址。Release 附件 exe **必须纯英文文件名**（中文名下载后可能被自动删除）。版本号须按序使用，**禁止**因某次构建失败就跳号（如 0.1.1 失败后直接发 0.1.2）。Use when the user asks to 打包 exe、发 Release、初始化私有仓库、版本发布、Windows 安装包/可执行文件交付、接单项目上 GitHub 发布，或提到类似 seller-sprite-agent / stock-org-hold-filler 的发布方式。
---

# 私有仓 Windows EXE 版本发布

## 目标
`

/** Real Cursor skill head carrying a tool-specific `environments` key. */
const CURSOR_HEAD = `---
name: automate
description: Use this skill to create Cursor Automations.
environments:
  - local
---
# Create Automation (Interactive)
`

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-ext-roots-'))
  tempRoots.push(root)
  await mkdir(join(root, 'alpha'))
  await writeFile(join(root, 'alpha', 'SKILL.md'), `---
name: alpha
description: Alpha directory skill
whenToUse: when the user asks for alpha
---
# Alpha
Body of alpha.
`)
  await writeFile(join(root, 'beta.md'), `---
name: beta
description: Beta flat skill
---
Flat body of beta.
`)
  await mkdir(join(root, 'gamma'))
  await writeFile(join(root, 'gamma', 'SKILL.md'), '---\nname: gamma\n---\nNo description.')
  await mkdir(join(root, 'delta'))
  await writeFile(join(root, 'delta', 'SKILL.md'), '---\nname: "Not A Kebab"\ndescription: Bad\n---\nBad.')
  await writeFile(join(root, 'notes.txt'), 'not a skill')
  await mkdir(join(root, '.system'))
  await writeFile(join(root, '.system', 'SKILL.md'), '---\nname: system-skill\ndescription: Internal\n---\nInternal.')
  return root
}

async function makeProvider(
  options: Partial<ExternalRootsProviderOptions> = {},
): Promise<{ ctx: Context; provider: ExternalRootsProvider; health: ExternalRootsHealth; invalidate: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  const invalidate = vi.fn()
  const health = new ExternalRootsHealth()
  const provider = new ExternalRootsProvider(ctx, {
    signal: new AbortController().signal,
    invalidate,
  }, {
    providerName: 'external-roots',
    enabled: { codex: false, claude: false, cursor: false, opencode: false },
    customDirs: [],
    agentsRoot: false,
    rank: 350,
    exclude: [],
    watch: false,
    ...options,
  }, health)
  return { ctx, provider, health, invalidate }
}

describe('defaultRootCandidates', () => {
  const on = { codex: true, claude: true, cursor: true, opencode: true }

  it('enumerates the default roots in scan order', () => {
    expect(defaultRootCandidates('/home/u', '/home/u/.agents', on, false, [])).toEqual([
      '/home/u/.codex/skills',
      '/home/u/.claude/skills',
      '/home/u/.cursor/skills',
      '/home/u/.cursor/skills-cursor',
      '/home/u/.config/opencode/skills',
    ])
  })

  it('drops a disabled family entirely', () => {
    const paths = defaultRootCandidates('/home/u', '/home/u/.agents', { ...on, codex: false }, false, [])
    expect(paths).not.toContain('/home/u/.codex/skills')
    expect(paths).toContain('/home/u/.claude/skills')
  })

  it('keeps cursor candidates exact and separate (no wildcard expansion)', () => {
    const paths = defaultRootCandidates('/home/u', '/home/u/.agents', { ...on, cursor: false }, false, [])
    expect(paths).not.toContain('/home/u/.cursor/skills')
    expect(paths).not.toContain('/home/u/.cursor/skills-cursor')
    expect(paths).not.toContain('/home/u/.cursor/skills-')
  })

  it('appends the agents root only when explicitly enabled, before custom dirs', () => {
    const paths = defaultRootCandidates('/home/u', '/custom-agents', on, true, ['/extra'])
    expect(paths[paths.length - 2]).toBe('/custom-agents/skills')
    expect(paths[paths.length - 1]).toBe('/extra')
    expect(defaultRootCandidates('/home/u', '/custom-agents', on, false, ['/extra'])).not.toContain('/custom-agents/skills')
  })

  it('appends custom dirs after every default', () => {
    const paths = defaultRootCandidates('/home/u', '/home/u/.agents', on, false, ['/a', '/b'])
    expect(paths.slice(-2)).toEqual(['/a', '/b'])
  })
})

describe('parseExternalSkill', () => {
  it('parses a real codex skill head (name + description + body)', () => {
    const outcome = parseExternalSkill(CODEX_HEAD)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.skill.name).toBe('gh-private-exe-release')
    expect(outcome.skill.description).toContain('私有 GitHub 仓')
    expect(outcome.skill.modelInvocable).toBe(true)
    expect(outcome.skill.userInvocable).toBe(true)
    expect(outcome.skill.content).toContain('# 私有仓 Windows EXE 版本发布')
    expect(outcome.skill.whenToUse).toBeUndefined()
  })

  it('ignores tool-specific extra keys such as Cursor environments', () => {
    const outcome = parseExternalSkill(CURSOR_HEAD)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.skill.name).toBe('automate')
    expect(outcome.skill.description).toBe('Use this skill to create Cursor Automations.')
    expect(outcome.skill.content).toContain('# Create Automation (Interactive)')
  })

  it('reads whenToUse and invocation policy keys', () => {
    const outcome = parseExternalSkill(`---
name: restricted
description: Restricted skill
whenToUse: only when explicitly invoked
disable-model-invocation: true
user-invocable: false
---
Body.`)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.skill.whenToUse).toBe('only when explicitly invoked')
    expect(outcome.skill.modelInvocable).toBe(false)
    expect(outcome.skill.userInvocable).toBe(false)
  })

  it('rejects a file without frontmatter', () => {
    const outcome = parseExternalSkill('# Just a heading\n\nNo frontmatter.')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('missing YAML frontmatter')
  })

  it('rejects a missing description', () => {
    const outcome = parseExternalSkill('---\nname: some-skill\n---\nBody.')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('requires name and description')
  })

  it('rejects an invalid kebab name', () => {
    const outcome = parseExternalSkill('---\nname: "Not A Kebab"\ndescription: d\n---\nBody.')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('invalid skill name')
  })

  it('rejects invalid YAML', () => {
    const outcome = parseExternalSkill('---\nname: [unclosed\ndescription: d\n---\nBody.')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('invalid YAML frontmatter')
  })

  it('trims the body of surrounding whitespace', () => {
    const outcome = parseExternalSkill('---\nname: x\ndescription: d\n---\n\n\nBody.\n\n\n')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.skill.content).toBe('Body.')
  })
})

describe('ExternalRootsProvider discovery', () => {
  it('lists directory bundles and flat md skills with source=external, rank and locator', async () => {
    const root = await makeTree()
    const { provider } = await makeProvider({ customDirs: [root] })
    const list = await provider.list({})
    const candidates = Array.isArray(list) ? list : list.candidates
    expect(candidates.map(candidate => candidate.name)).toEqual(['alpha', 'beta'])
    const alpha = candidates.find(candidate => candidate.name === 'alpha')!
    expect(alpha.description).toBe('Alpha directory skill')
    expect(alpha.whenToUse).toBe('when the user asks for alpha')
    expect(alpha.source).toBe(EXTERNAL_SOURCE)
    expect(alpha.provider).toBe('external-roots')
    expect(alpha.rank).toBe(350)
    expect(alpha.resourceBase).toEqual({ kind: 'directory', path: join(root, 'alpha') })
    expect(alpha.path).toBe(join(root, 'alpha', 'SKILL.md'))
    expect(alpha.locator).toEqual({ path: join(root, 'alpha', 'SKILL.md'), directory: join(root, 'alpha') })
    expect(alpha.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    const beta = candidates.find(candidate => candidate.name === 'beta')!
    expect(beta.path).toBe(join(root, 'beta.md'))
    expect(beta.resourceBase).toEqual({ kind: 'directory', path: root })
  })

  it('skips .system internal skills, unparseable entries and non-md files with warnings', async () => {
    const root = await makeTree()
    const { provider } = await makeProvider({ customDirs: [root] })
    const list = await provider.list({})
    const candidates = Array.isArray(list) ? list : list.candidates
    const names = candidates.map(candidate => candidate.name)
    expect(names).not.toContain('system-skill')
    expect(names).not.toContain('gamma')
    expect(names).not.toContain('delta')
    expect(names).not.toContain('notes')
  })

  it('returns an incomplete observation when a root scan fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-ext-blocked-'))
    tempRoots.push(root)
    const blocked = join(root, 'blocked')
    await mkdir(blocked)
    await writeFile(join(blocked, 'x.md'), '---\nname: x\ndescription: d\n---\nBody.')
    await chmod(blocked, 0o000)
    try {
      const { provider } = await makeProvider({ customDirs: [blocked] })
      const result = await provider.list({})
      expect(Array.isArray(result)).toBe(false)
      if (!Array.isArray(result)) expect(result.complete).toBe(false)
    } finally {
      await chmod(blocked, 0o755)
    }
  })

  it('applies the exclude list by parsed skill name', async () => {
    const root = await makeTree()
    const { provider } = await makeProvider({ customDirs: [root], exclude: ['beta'] })
    const list = await provider.list({})
    const candidates = Array.isArray(list) ? list : list.candidates
    expect(candidates.map(candidate => candidate.name)).toEqual(['alpha'])
  })

  it('honors a custom rank and provider name', async () => {
    const root = await makeTree()
    const { provider } = await makeProvider({ customDirs: [root], rank: 500, providerName: 'custom-provider' })
    const list = await provider.list({})
    const candidates = Array.isArray(list) ? list : list.candidates
    expect(candidates.every(candidate => candidate.rank === 500)).toBe(true)
    expect(candidates.every(candidate => candidate.provider === 'custom-provider')).toBe(true)
  })

  it('records health probes for existing and missing roots', async () => {
    const root = await makeTree()
    const { provider, health } = await makeProvider({ customDirs: [root, join(root, 'nope')] })
    await provider.list({})
    const probes = health.snapshot()
    expect(probes.length).toBe(2)
    const existing = probes.find(probe => probe.root === root)!
    expect(existing.exists).toBe(true)
    expect(existing.candidates.map(path => path.split('/').pop())).toEqual(['SKILL.md', 'beta.md'])
    const missing = probes.find(probe => probe.root === join(root, 'nope'))!
    expect(missing.exists).toBe(false)
    expect(missing.candidates).toEqual([])
  })

  it('does not mount ~/.agents/skills by default, and mounts it when agentsRoot is on', async () => {
    const agentsHome = await mkdtemp(join(tmpdir(), 'skill-ext-agents-'))
    tempRoots.push(agentsHome)
    await mkdir(join(agentsHome, 'skills', 'agent-skill'), { recursive: true })
    await writeFile(join(agentsHome, 'skills', 'agent-skill', 'SKILL.md'), '---\nname: agent-skill\ndescription: Agent skill\n---\nBody.')

    const off = await makeProvider({ agentsHome })
    const offList = await off.provider.list({})
    const offCandidates = Array.isArray(offList) ? offList : offList.candidates
    expect(offCandidates.map(candidate => candidate.name)).not.toContain('agent-skill')

    const on = await makeProvider({ agentsHome, agentsRoot: true })
    const onList = await on.provider.list({})
    const onCandidates = Array.isArray(onList) ? onList : onList.candidates
    expect(onCandidates.map(candidate => candidate.name)).toEqual(['agent-skill'])
  })

  it('get() returns the body and rejects a renamed or vanished skill', async () => {
    const root = await makeTree()
    const { provider } = await makeProvider({ customDirs: [root] })
    const list = await provider.list({})
    const candidates = Array.isArray(list) ? list : list.candidates
    const alpha = candidates.find(candidate => candidate.name === 'alpha')!

    const definition = await provider.get(alpha, {})
    expect(definition).toBeDefined()
    expect(definition!.name).toBe('alpha')
    expect(definition!.content).toBe(clean('# Alpha\nBody of alpha.'))
    expect(definition!.path).toBe(join(root, 'alpha', 'SKILL.md'))

    // Rename the frontmatter name: the definition no longer matches the candidate.
    await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: renamed\ndescription: Alpha skill\n---\nBody.')
    await expect(provider.get(alpha, {})).resolves.toBeUndefined()

    // Vanished file: undefined as well.
    const beta = candidates.find(candidate => candidate.name === 'beta')!
    await rm(join(root, 'beta.md'))
    await expect(provider.get(beta, {})).resolves.toBeUndefined()
  })
})

describe('ExternalRootsProvider watch', () => {
  it('invalidates when a skill directory is added to a watched root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-ext-watch-'))
    tempRoots.push(root)
    const { provider, invalidate } = await makeProvider({
      customDirs: [root],
      watch: true,
      watchUsePolling: true,
      watchPollIntervalMs: 50,
      watchStabilityThresholdMs: 10,
    })
    try {
      await provider.list({})
      await mkdir(join(root, 'new-skill'))
      await writeFile(join(root, 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: New\n---\nBody.')
      await vi.waitFor(() => { expect(invalidate).toHaveBeenCalled() }, { timeout: 10_000 })
      // The next list() sees the new skill.
      const list = await provider.list({})
      const candidates = Array.isArray(list) ? list : list.candidates
      expect(candidates.map(candidate => candidate.name)).toContain('new-skill')
    } finally {
      await provider.dispose()
    }
  })

  it('does not watch when watch is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-ext-nowatch-'))
    tempRoots.push(root)
    const { provider, invalidate } = await makeProvider({ customDirs: [root], watch: false })
    try {
      await provider.list({})
      await mkdir(join(root, 'new-skill'))
      await writeFile(join(root, 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: New\n---\nBody.')
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(invalidate).not.toHaveBeenCalled()
    } finally {
      await provider.dispose()
    }
  })
})

describe('pathInsideRoot', () => {
  it('accepts a path strictly inside the root', () => {
    expect(pathInsideRoot('/r', '/r/a/SKILL.md')).toBe(true)
    expect(pathInsideRoot('/r', '/r/beta.md')).toBe(true)
  })

  it('rejects the root itself and paths outside it', () => {
    expect(pathInsideRoot('/r', '/r')).toBe(false)
    expect(pathInsideRoot('/r', '/other/SKILL.md')).toBe(false)
    expect(pathInsideRoot('/r', '/r-other/SKILL.md')).toBe(false)
  })
})

describe('checkExternalRootsHealth (package invariant)', () => {
  const failuresOf = (): { failures: string[]; fail: (message: string) => never } => {
    const failures: string[] = []
    return {
      failures,
      fail: (message: string): never => {
        failures.push(message)
        throw new Error(message)
      },
    }
  }

  it('accepts a consistent snapshot', () => {
    const health = new ExternalRootsHealth()
    health.record({ root: '/r', exists: true, candidates: ['/r/a/SKILL.md', '/r/b.md'], scannedAt: 1 })
    health.record({ root: '/gone', exists: false, candidates: [], scannedAt: 1 })
    const { failures, fail } = failuresOf()
    checkExternalRootsHealth(health, fail)
    expect(failures).toEqual([])
  })

  it('rejects a candidate whose path lies outside its recorded root', () => {
    const health = new ExternalRootsHealth()
    health.record({ root: '/r', exists: true, candidates: ['/outside/SKILL.md'], scannedAt: 1 })
    const { fail } = failuresOf()
    expect(() => checkExternalRootsHealth(health, fail)).toThrow(/outside its recorded root/)
  })

  it('rejects a missing root that produced candidates', () => {
    const health = new ExternalRootsHealth()
    health.record({ root: '/gone', exists: false, candidates: ['/gone/a/SKILL.md'], scannedAt: 1 })
    const { fail } = failuresOf()
    expect(() => checkExternalRootsHealth(health, fail)).toThrow(/missing but produced/)
  })

  it('skips when no plugin instance has registered health', () => {
    const { fail } = failuresOf()
    expect(() => checkExternalRootsHealth(undefined, fail)).not.toThrow()
  })

  it('registers the manifest name and re-checks the relation on skills/change', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(invariantPlugin)
    const health = new ExternalRootsHealth()
    registerExternalRootsHealth(health)
    // A clean snapshot passes the install-time check; a recorded violation is
    // then reported when the registry notifies catalog changes.
    health.record({ root: '/root', exists: true, candidates: ['/root/a/SKILL.md'], scannedAt: 1 })
    expect(() => ctx.emit('skills/change')).not.toThrow()
    health.record({ root: '/root', exists: true, candidates: ['/outside/SKILL.md'], scannedAt: 2 })
    expect(() => ctx.emit('skills/change')).toThrow(/outside its recorded root/)
    await ctx.fiber.dispose()
  })
})
