# np-tooling

Neural Partners' public home for Pi packages, extensions, skills, prompts, themes, and related tooling.

## What lives here

- `packages/*` — public npm packages that can be installed by Pi.
- `local/` — local experiments and personal packages; contents are gitignored except the README.
- `private/` — Neural Partners internal or customer-specific packages; contents are gitignored except the README. Internal packages ship as git packages, not npm registry packages.
- `docs/` — repo conventions, publishing notes, and implementation specs/plans.

## Current public packages

| Package                 | Purpose                                                                  | Install                                      |
| ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `@neuralpartners/pi-yo` | Trusted-local Pi messaging; room prototype held back (0.4.0 deprecated). | `pi install npm:@neuralpartners/pi-yo@0.3.0` |

See each package's README for package-specific usage, license, local smoke tests, and verification details. For unpublished package changes, test from a fresh `origin/main` worktree or install the package by local path; the primary checkout in this repo may be intentionally behind while other worktrees carry release candidates.

## Development

Use Node.js >=22.19.0 and npm workspaces. The unreleased pi-yo source targets @earendil-works/pi-coding-agent 0.85.1 only; legacy host support is no longer declared. See the package README for release blockers and disposable QA commands.

```bash
npm ci --ignore-scripts
npm run verify
```

Root verification runs workspace checks where packages define them, then checks Markdown/JSON/YAML formatting with Prettier.

## Pi package conventions

See [`docs/pi-packages.md`](docs/pi-packages.md).

Short version:

- public npm packages live under `packages/<name>/`
- internal NP packages ship as git packages, not npm registry packages
- package manifests include the `pi-package` keyword for discoverability
- package manifests declare Pi resources under the `pi` key when conventional directories are not enough
- runtime dependencies live in the package that uses them
- Pi-provided APIs such as `@earendil-works/pi-coding-agent` and `typebox` should usually be peer dependencies

## Publishing

See [`docs/publishing.md`](docs/publishing.md).

Tokens must come from AWS SSM Parameter Store or local environment variables. Never commit tokens, `.npmrc`, or generated auth files.

## License

This repo is a container for multiple packages. Package-level `package.json` and `LICENSE` files govern package code. See [`LICENSE`](LICENSE) for the repo-level licensing note.
