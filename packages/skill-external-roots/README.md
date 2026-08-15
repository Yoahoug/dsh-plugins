# @dsh-plugins/skill-external-roots

English | [中文](README.zh.md)

A `SkillProvider` for the harness [skills capability seam](../../../deepseek-harness/docs/subsystems/skills.zh.md) (`ctx.skills`) that mounts skills already present in external agent tool roots — OpenAI Codex `~/.codex/skills`, Claude Code `~/.claude/skills`, Cursor `~/.cursor/skills*`, OpenCode `~/.config/opencode/skills` — into the running registry as `source: 'external'` candidates at **rank 350** (after project skills 100/200, before user skills 400/500). Skills written for those tools become directly callable by the dsh model through the standard `skill()` tool and the `<available_skills>` catalog.

This is an **implementation** package: it registers a provider into `ctx.skills`, it does not own the `ctx.skills` key (that is `@deepseek-ai/dsh-skill`), and it registers no model-facing tool (that is `@deepseek-ai/dsh-tool-skill`). It is a function/namespace plugin (`inject: ['skills']`) that registers into the registry, exactly like `@deepseek-ai/dsh-skill-filesystem`.

## Root mapping

| Tool | Default root | Notes |
|---|---|---|
| OpenAI Codex | `~/.codex/skills` | Only user skills beside `.system/` are mounted; the tools' own internal `.system` skills are skipped. |
| Claude Code | `~/.claude/skills` | |
| Cursor | `~/.cursor/skills`, `~/.cursor/skills-cursor` | Cursor has no single global path; these exact candidates are probed (never a wildcard expansion) and only existing ones mount. |
| OpenCode | `~/.config/opencode/skills` | Candidate root; skipped silently when absent. |
| Agents (opt-in) | `$DSH_AGENTS_HOME`/`~/.agents` `/skills` | **Off by default**: the built-in `skill-filesystem` provider already scans it (user-agents rank 500) — mounting it here would list every agent skill twice. |

Non-existent roots are silently skipped. `customDirs` appends arbitrary roots (also `source: 'external'`).

## Config

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `external-roots` | Unique provider name in the `ctx.skills` registry (a separate layer from the built-in `filesystem`). |
| `enabled.codex` / `claude` / `cursor` / `opencode` | `true` | Per-tool family switch; a disabled family is never probed. |
| `customDirs` | `[]` | Extra roots scanned after the defaults, in order. |
| `agentsRoot` | `false` | Explicitly mount `~/.agents/skills` (duplicates the built-in provider — only for special setups). |
| `rank` | `350` | Candidate rank; project (100/200) < external < user (400/500). |
| `exclude` | `[]` | Skill names dropped from the catalog by parsed frontmatter `name`. |
| `watch` | `true` | Chokidar invalidates the registry on direct-root changes (add/remove of a skill, `SKILL.md` edits). |

Patch line (profile `cordis.patch.yml`):

```yaml
- insert:
    - id: skill-external-roots
      name: '@dsh-plugins/skill-external-roots'
      config:
        enabled:
          codex: true
          claude: true
          cursor: true
          opencode: true
```

Install: `dsh plugin --profile web add file:<abs path>/packages/skill-external-roots` (a `file:` install needs no pnpm `allowBuilds` grant; run `pnpm run build` first so `lib/` exists).

## Discovery rules

Reuses the official local-provider conventions ([`skill-filesystem`](../../../deepseek-harness/packages/skill/skill-filesystem/src/index.ts)): directory bundles `<kebab>/SKILL.md` and flat `<kebab>.md`; a `---`-delimited YAML frontmatter mapping requiring a kebab-case `name` and a non-blank `description`; optional `whenToUse`, `disable-model-invocation`, `user-invocable`, and `metadata`. Tool-specific extra keys (Cursor `environments`, Codex `license`, ...) are ignored. A file with missing/invalid frontmatter, an invalid kebab name, or a name on the `exclude` list is skipped with a logger warning naming the file. Candidates carry `source: 'external'`, the configured `provider`/`rank`, a `{ path, directory }` locator, and a `resourceBase` of `{ kind: 'directory' }`. `get()` re-reads the file body; a definition whose frontmatter `name` no longer matches the candidate is rejected (the registry invalidates and rediscovers).

## Model Experience

Indirectly, through [`dsh-tool-skill`](../../../deepseek-harness/packages/skill/tool-skill/README.md): the model's `<available_skills>` catalog gains the external skills (their `name` + `description` only — never the body or absolute paths), and `skill({ name })` loads the full body on demand with `resourceBase` resolving relative resources against the skill's directory. A skill that disappears from disk after listing loads as unavailable. `skills/change` invalidates consumer catalogs when a root directory changes (watcher on), so model-facing catalogs refresh without a restart.

#### KV Cache effect

No direct invalidation beyond the `skills/change` catalog refresh: the model-side catalog digest changes only when listed names/descriptions change; a body-only edit changes later `skill()` loads without regenerating the catalog message.

## Known Limitations and Deferred Work

- **`watch: false` means no live refresh**: without the watcher the registry only re-collects after another invalidation (another provider's change, a new `cwd`, or an app restart) — document this escape hatch when you disable it.
- **A brand-new root appears on the next discovery, not instantly**: creating `~/.codex/skills` from nothing is observed through the nearest-existing-ancestor poll and invalidates on the next catalog read; native chokidar events cover changes inside an already-existing root.
- **Same-name skills resolve by root scan order** (codex → claude → cursor → opencode → agents → `customDirs`): within one rank the first root wins. Override by using a higher-priority provider (project/user roots) or a dedicated `rank`.
- **`.system` internal skill buckets are skipped** (Codex ships `review-agent`, `skill-creator`, ... there); a user skill literally named `.system` cannot be mounted.
- **No settings-form UI**: v1 config travels through the profile patch (the dev plan's §4.4 HTTP management endpoint is deferred to v2).
- **OpenCode's global root is a candidate, not a standard**: `~/.config/opencode/skills` is probed and silently skipped when absent; add a custom root via `customDirs` if your install differs.
- **Cursor paths are a probe list, not a scan**: `~/.cursor/skills*`-style directories other than the two probed candidates need `customDirs`.

## Invariant companion

`@dsh-plugins/skill-external-roots/invariant` registers the package's manifest name and checks the scan→candidate data relation on every `skills/change`: every recorded candidate path must lie inside its recorded root, and a root recorded as missing must produce no candidates. Mount it as a separate row when the runtime carries the `invariants` service:

```yaml
- insert:
    - id: skill-external-roots-invariant
      name: '@dsh-plugins/skill-external-roots/invariant'
```
