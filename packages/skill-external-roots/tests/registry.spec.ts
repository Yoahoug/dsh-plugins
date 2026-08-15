import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as externalRootsPlugin from '@dsh-plugins/skill-external-roots'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function skillRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `skill-ext-reg-${name}-`))
  tempRoots.push(root)
  return root
}

async function addSkill(root: string, name: string, description: string, body = 'Body.'): Promise<void> {
  await mkdir(join(root, name))
  await writeFile(join(root, name, 'SKILL.md'), `---
name: ${name}
description: ${description}
---
${body}`)
}

interface Setup {
  ctx: Context
  entryId: string
}

/**
 * Assemble the skill registry plus this plugin through the real Cordis plugin
 * loader (the same machinery a profile composition uses): the loader owns an
 * entry tree, imports plugin modules by name, and applies their config.
 * `loader.internal` stubs the module import with the in-process modules so the
 * test runs against source (vitest aliases) without a built `lib/`.
 */
async function setup(roots: readonly string[]): Promise<Setup> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-skill', SkillRegistry],
        ['@dsh-plugins/skill-external-roots', externalRootsPlugin],
      ])
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: '@deepseek-ai/dsh-skill' })
  const entryId = await ctx.loader.create({
    name: '@dsh-plugins/skill-external-roots',
    config: { customDirs: roots, watch: false },
  })
  await ctx.loader.await()
  return { ctx, entryId }
}

/** Unmount the plugin entry and wait for the loader to settle its teardown. */
async function removePlugin(setup: Setup): Promise<void> {
  await setup.ctx.loader.remove(setup.entryId)
  await setup.ctx.loader.await()
}

describe('skill-external-roots registry integration', () => {
  it('mounts external skills into ctx.skills and loads their bodies', async () => {
    const root = await skillRoot('basic')
    await addSkill(root, 'alpha', 'Alpha skill')
    await addSkill(root, 'beta', 'Beta skill', 'Beta body here.')

    const { ctx, entryId } = await setup([root])
    const list = await ctx.skills.list({ cwd: process.cwd() })

    const alpha = list.find(skill => skill.name === 'alpha')
    expect(alpha).toBeDefined()
    expect(alpha!.source).toBe('external')
    expect(alpha!.provider).toBe('external-roots')
    expect(alpha!.description).toBe('Alpha skill')
    expect(alpha!.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(alpha!.resourceBase).toEqual({ kind: 'directory', path: join(root, 'alpha') })
    expect(list.find(skill => skill.name === 'beta')?.description).toBe('Beta skill')

    const definition = await ctx.skills.get('alpha', { cwd: process.cwd() })
    expect(definition).toBeDefined()
    expect(definition!.content).toBe('Body.')
    expect(definition!.path).toBe(join(root, 'alpha', 'SKILL.md'))

    await removePlugin({ ctx, entryId })
    const after = await ctx.skills.list({ cwd: process.cwd() })
    expect(after.find(skill => skill.name === 'alpha')).toBeUndefined()
  })

  it('resolves same-name skills from multiple roots by scan order (first root wins)', async () => {
    const first = await skillRoot('dup1')
    const second = await skillRoot('dup2')
    await addSkill(first, 'dup', 'Description from the first root')
    await addSkill(second, 'dup', 'Description from the second root')

    const { ctx, entryId } = await setup([first, second])
    const list = await ctx.skills.list({ cwd: process.cwd() })
    const dup = list.filter(skill => skill.name === 'dup')
    expect(dup.length).toBe(1)
    expect(dup[0]!.description).toBe('Description from the first root')

    await removePlugin({ ctx, entryId })
  })

  it('keeps the runtime layer free of the plugin after disposal', async () => {
    const root = await skillRoot('dispose')
    await addSkill(root, 'only-skill', 'Only skill')

    const { ctx, entryId } = await setup([root])
    await expect(ctx.skills.list({ cwd: process.cwd() })).resolves.toContainEqual(
      expect.objectContaining({ name: 'only-skill', source: 'external' }),
    )
    await removePlugin({ ctx, entryId })
    const after = await ctx.skills.list({ cwd: process.cwd() })
    expect(after.find(skill => skill.name === 'only-skill')).toBeUndefined()
  })
})
