# Publishing and Secrets

This repo is public. Do not commit tokens, generated auth files, `.npmrc`, `.env`, or customer-specific package contents.

Publishing rule: only public packages are registered/published to npm. Internal Neural Partners packages ship as git packages and should be installed from git URLs/tags/SHAs instead of the npm registry.

## Secret locations

Existing secrets are stored in AWS SSM Parameter Store in `us-east-1`.

| Secret     | SSM ARN                                                            |
| ---------- | ------------------------------------------------------------------ |
| GitHub PAT | `arn:aws:ssm:us-east-1:047719662689:parameter/np/prod/github-pat`  |
| NPM PAT    | `arn:aws:ssm:us-east-1:047719662689:parameter/np/npm/access-token` |

Use AWS profile `scott` from the local machine.

## Read the npm token safely

```bash
export NPM_TOKEN="$(aws ssm get-parameter \
  --profile scott \
  --region us-east-1 \
  --name /np/npm/access-token \
  --with-decryption \
  --query Parameter.Value \
  --output text)"
```

Then use the environment token directly or copy `.npmrc.example` to a local `.npmrc` file. `.npmrc` is gitignored.

## Read the GitHub token safely

```bash
export GITHUB_TOKEN="$(aws ssm get-parameter \
  --profile scott \
  --region us-east-1 \
  --name /np/prod/github-pat \
  --with-decryption \
  --query Parameter.Value \
  --output text)"
```

Prefer the GitHub CLI or existing SSH credentials for normal git operations. Use the PAT only when an operation explicitly requires it.

## Internal git package release checklist

For internal-only packages:

- keep package contents out of npm publishing workflows
- install from git URLs, tags, or SHAs
- never include secrets, auth files, `.env`, customer data, or machine-specific runtime state
- tag stable internal releases when agents need repeatable installs
- document the intended Pi install command in the package README

## Manual npm publish checklist

Publish only from a clean worktree created from the intended `origin/main` commit/tag. Do not publish from the primary checkout when it is behind or dirty.

Run from the repo root first:

```bash
npm install
npm run verify
npm pack --workspace <package-name> --dry-run
```

Then run package-specific smoke tests when present:

```bash
npm run smoke:rooms --workspace @neuralpartners/pi-yo
```

Publish from the package directory only after the checks above pass:

```bash
cd packages/<package-name>
npm publish --access public
```

Before publishing:

- confirm `package.json` has the intended `name`, `version`, `license`, `repository`, and `publishConfig`
- confirm npm does not already have that version: `npm view <package-name> version versions --json`
- confirm the package README has install, local-path testing, rollback, and verification instructions
- confirm any documented CLI bins are included in `package.json#bin` and in shim diagnostics/sync docs when applicable
- confirm package-specific smoke commands are documented and pass from a temporary `HOME` when they write local state
- confirm `npm pack --dry-run` does not include private files
- confirm the package's license is intentional

## GitHub Actions publishing

CI publishing is intentionally not configured yet. Add release automation only after release policy is explicit.
