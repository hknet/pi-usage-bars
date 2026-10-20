# Releasing

This repository uses semantic versions. The package version, changelog heading, Git tag, and npm version must agree.

Local releases use npm staged publishing followed by browser 2FA approval. Browser login only authenticates the CLI; it does not publish or approve a staged package. The GitHub Actions publish workflow is manual-only; pushing a tag does not publish the package.

## Prerequisites

- Write access to `hknet/pi-usage-bars`.
- Publish access to the npm scope `@hk_net`.
- Node.js 22.19 or newer.
- A clean, synchronized `main` branch.

Never place an npm token in the repository, command history, or endpoint configuration. Complete npm's browser or OTP authorization when prompted.

## Recommended release script

From the repository root, provide the exact new semantic version:

```bash
cd /path/to/pi-usage-bars
scripts/release.sh X.Y.Z
```

From Windows PowerShell, run the Bash workflow through WSL (replace the WSL path with your checkout):

```powershell
wsl bash -lc 'cd /mnt/c/path/to/pi-usage-bars && ./scripts/release.sh X.Y.Z'
```

The repository's `.gitattributes` keeps shell scripts on LF endings so they remain executable in WSL even when Git for Windows uses `core.autocrlf=true`.

This **default command only prepares the release**. It deliberately stops before npm login or publication, so the pushed release commit can be reviewed first. The launcher first executes an immutable temporary copy of itself, so editing the script while a release is running cannot corrupt that run.

Preparation:

1. verifies that `main` is clean and synchronized with `origin/main`;
2. rejects an existing npm version or Git tag;
3. updates `package.json` and `package-lock.json` without creating an early tag;
4. promotes the `Unreleased` changelog entries into a dated release while preserving an empty `Unreleased` heading;
5. installs dependencies with `npm ci --no-audit`, provisions a temporary pinned Bun binary, and runs typecheck, tests, detailed dependency audits, tarball verification, and package dry-run; and
6. commits and pushes the release source.

After reviewing the prepared commit, stage it for browser approval:

```bash
scripts/release.sh X.Y.Z stage
```

From Windows PowerShell:

```powershell
wsl bash -lc 'cd /mnt/c/path/to/pi-usage-bars && ./scripts/release.sh X.Y.Z stage'
```

`stage` submits the package to npm's staged-publishing queue. It **does not publish live**, does not open a browser, and does not tag Git. If npm authentication is needed, run `npm login --auth-type=web` manually first; this only authenticates the CLI.

In [npmjs.com](https://www.npmjs.com), open **Staged Packages**, review the staged tarball, and click **Approve**. npm prompts for 2FA during approval. After npm shows the version as live, finalize the release:

```bash
scripts/release.sh X.Y.Z finalize
```

From Windows PowerShell:

```powershell
wsl bash -lc 'cd /mnt/c/path/to/pi-usage-bars && ./scripts/release.sh X.Y.Z finalize'
```

`finalize` refuses to run until the exact version is live in the npm registry. It then verifies registry metadata and creates/pushes the annotated Git tag. It never stages or publishes a package.

Use `--yes` only for attended preparation:

```bash
scripts/release.sh X.Y.Z --yes  # prepare only
```

## Recovery

Staging and finalization are safe to rerun: `stage` refuses if the exact version is already live, and `finalize` refuses until it is live. Never force-push a release tag.

The release script first prints a full dependency audit with package names, dependency paths, affected ranges, and available fixes. This is informational because it includes development-only dependencies. It then runs a blocking production-only audit, which rejects high or critical production findings.

Show script help with:

```bash
scripts/release.sh --help
```

## Post-release verification

Confirm installation through Pi:

```bash
pi install npm:@hk_net/pi-usage-bars
# If already installed from npm:
pi update npm:@hk_net/pi-usage-bars
```

Restart Pi, or use `/reload`, then run `/usage`.

## GitHub Actions alternative

The **Publish to npm (manual)** workflow is available as an alternative. It requires the `NPM_TOKEN` repository secret and publishes with npm provenance. Do not run it after publishing the same version locally.
