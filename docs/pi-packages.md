# Pi Package Conventions

This repo follows Pi's package conventions for sharing extensions, skills, prompt templates, and themes through npm or git.

## Public package layout

Public packages live under `packages/<package-name>/`.

Each package should own its own:

- `package.json`
- `README.md`
- `LICENSE` when the package license differs from repo-level defaults
- `extensions/`, `skills/`, `prompts/`, or `themes/` directories as needed
- tests and package-level verification scripts

## package.json metadata

Add the `pi-package` keyword to publishable Pi packages:

```json
{
  "keywords": ["pi-package"]
}
```

Use the `pi` manifest when explicit resource paths are clearer than discovery by convention:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Pi also discovers conventional directories when no explicit manifest is present:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds directories containing `SKILL.md`
- `prompts/` loads Markdown prompt templates
- `themes/` loads JSON themes

## Extension packages

Small extensions can be single files:

```txt
extensions/my-extension.ts
```

Larger extensions should use a folder with an entrypoint:

```txt
extensions/my-extension/index.ts
```

Rules of thumb:

- keep runtime dependencies in the package-level `dependencies`
- keep test-only tools in `devDependencies`
- list Pi-provided APIs as peer dependencies when imported by the extension
- test core logic outside Pi interactive mode when possible
- document source-checkout vs installed-package commands when a package exposes CLI bins; npm latest can lag `origin/main`
- provide package smoke scripts for local-first stateful features, and make them use a temporary `HOME` unless they intentionally mutate real Pi state

Common peer dependencies for Pi extension packages:

```json
{
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

Use narrower ranges in real packages after compatibility is verified.

## Skill packages

Skills follow the Agent Skills structure:

```txt
skills/my-skill/SKILL.md
```

Skill names must be lowercase, hyphenated, and match the parent directory name.

A minimal skill file:

```markdown
---
name: my-skill
description: Use when a task needs the specific workflow this skill provides.
---

# My Skill

Instructions go here.
```

Descriptions matter because Pi uses them to decide when to load the skill.

## Publishing model

Use two lanes:

- **Public packages** live under `packages/<package-name>/` and are published/registered on npm.
- **Internal Neural Partners packages** ship as git packages. Do not publish internal-only packages to npm.

Public npm packages should include registry-safe metadata, public docs, public assets, and no Neural Partners/customer-specific defaults.

Internal git packages can still follow Pi package conventions (`package.json`, `pi` manifest, `extensions/`, `skills/`, `prompts/`, `themes/`) but should be installed from git URLs rather than npm registry names.

## Local and private work

Use `local/` for personal experiments and `private/` for internal/customer-specific work. Both directories are gitignored except for README placeholders.
