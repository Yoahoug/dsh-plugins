import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as externalRootsPlugin from '@dsh-plugins/skill-external-roots'

/**
 * Real-machine smoke for the external-roots provider. Self-skips when neither
 * the codex nor the cursor skill root exists (CI has no such directories),
 * per the no-credential e2e policy.
 */
const codexRoot = join(homedir(), '.codex', 'skills')
const cursorRoot = join(homedir(), '.cursor', 'skills-cursor')
const maybe = existsSync(codexRoot) || existsSync(cursorRoot) ? describe : describe.skip

maybe('skill-external-roots on real machine roots', () => {
  it('lists real external skills with source=external and loads a body', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(externalRootsPlugin, {
      enabled: { codex: true, claude: false, cursor: true, opencode: false },
      watch: false,
    })
    const list = await ctx.skills.list()
    const external = list.filter(skill => skill.source === 'external')
    expect(external.length).toBeGreaterThan(0)
    expect(external.every(skill => skill.provider === 'external-roots')).toBe(true)

    if (existsSync(codexRoot)) {
      const codexNames = external.map(skill => skill.name)
      expect(codexNames.some(name => [
        'read-opencode-session',
        'gh-private-exe-release',
        'miniapp-request-study',
      ].includes(name))).toBe(true)
    }

    const any = external[0]
    if (any !== undefined) {
      const definition = await ctx.skills.get(any.name)
      expect(definition).toBeDefined()
      expect(definition!.content.length).toBeGreaterThan(0)
    }
    await fiber.dispose()
  })
})
