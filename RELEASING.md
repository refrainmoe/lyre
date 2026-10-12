# Releasing

The public `@refrain-lyre` npm packages built from this repository are `@refrain-lyre/core`,
`@refrain-lyre/schemas`, `@refrain-lyre/render-soft`, `@refrain-lyre/render-webgl`, and
`@refrain-lyre/validate`. They are published by GitHub Actions, never from a developer machine:
pushing a `v<version>` tag runs [`.github/workflows/release.yml`](./.github/workflows/release.yml),
which verifies the tag, re-runs the tarball gate through each package's `prepublishOnly` hook,
and publishes in dependency order. The specification itself is released by the same tag; it has
no separate publish step.

## What the release gate checks

Every public package's `prepublishOnly` hook runs `tools/prepublish.mjs`, which refuses npm or an
unpinned pnpm and then runs `pnpm release:check`. `release:check` starts with no ignored `dist/`
output, runs every package's real `prepack`, opens the resulting tarballs, verifies exports, bins,
peer/runtime identity, public registry metadata, and declaration consumption without ambient Node
types. It also installs the exact tarballs together through pnpm in an offline clean consumer,
then checks that their peer graph, runtime imports, types, and installed `lyre-validate`
executable work. CI runs the same gate on every push, so a release tag should never be the first
time it runs against a commit.

The exact package manager in `packageManager` (`pnpm@11.15.1`) is part of the release contract;
the workflow pins the same version. To reproduce the gate locally:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm release:check
```

## One-time setup

1. **Own the scope.** The npm organization `refrain-lyre` must exist and the account that
   performs the bootstrap below must be a member with publish rights. An unpublished scoped name
   looks free from the outside, but nothing can be published into it without owning the scope.
2. **Public links.** Every package manifest's `repository`, `homepage`, and `bugs` URL, and every
   cross-link in the package READMEs, points at `github.com/refrainmoe/lyre`. npm renders them on
   the package page, so the repository must be public before the first publish.
3. **GitHub environment.** Create an environment named `npm` in the repository settings. The
   release job runs in it, which is what lets npm pin the trusted publisher to that environment
   and lets you add required reviewers to publishes later if you want them.

## Bootstrap: the first publish of the scope

npm cannot configure a trusted publisher for a package that has never been published, so the very
first release of each package needs a token. This happens once for the scope; afterwards the
token is deleted and never needed again.

1. On npmjs.com, create a **granular access token**: read and write on the `@refrain-lyre` scope
   (packages and scopes only, no organization or user permissions), the shortest expiry offered,
   and **bypass two-factor authentication** enabled, which automation requires.
2. Add it as the secret `NPM_TOKEN` on the `npm` environment (not as a repository-wide secret).
3. Cut the release as described below. The workflow passes the secret to pnpm and publishes with
   token authentication. Provenance is not attached to a token publish; that begins with the next
   release.
4. On npmjs.com, open each of the five packages, go to **Settings → Trusted Publisher**, choose
   GitHub Actions, and enter: organization or user `refrainmoe`, repository `lyre`, workflow
   filename `release.yml`, environment `npm`.
5. Delete the `NPM_TOKEN` secret from the environment and revoke the token on npmjs.com. From now
   on the workflow authenticates through OpenID Connect with no stored credential, and npm attaches
   provenance attestations automatically.
6. Optionally, in each package's settings choose **Require two-factor authentication and
   disallow tokens**, which blocks any future token publish while leaving trusted publishing
   allowed.

## Cutting a release

1. **Set the version.** All five public packages share one version. Update `version` in each
   public `packages/*/package.json` and the `publicVersion` constant in
   `tools/check-packages.mjs`; the gate fails if they disagree, and the workflow refuses a tag
   that does not match. Update the version date in `spec/lyre.md` and `spec/README.md` to the
   release date, and, for a MINOR or MAJOR change, the `lyre` version strings the spec describes
   in §15.
2. **Commit and push to `master`.** Wait for the CI workflow to pass on that commit. Publishing is
   a handoff from a reviewed commit, not a way to capture working-tree changes.
3. **Tag the exact commit and push the tag.** The tag name is `v` followed by the package version:
   ```sh
   git tag -a v0.1.0 -m "Lyre 0.1.0" <commit>
   git push origin v0.1.0
   ```
4. **Watch the release workflow.** It fails fast if the tag is not on `master` or does not match
   the package version. Otherwise it publishes `core` and `schemas`, then the renderers, then the
   validator, running the full gate before each.
5. **Verify** with `npm view @refrain-lyre/core` and by following the repository link from one
   package page.

## If a release fails midway

A published version is permanent on npm. If some packages published and a later one failed, fix
the cause on `master`, move nothing on npm, and rerun the workflow from the Actions tab on the same
tag: recursive publish skips versions the registry already has and publishes only the missing
packages. If the fix changes package contents that already shipped, bump to the next patch version
and cut a new release instead.

## Why the workflow passes `--no-git-checks`

pnpm's git checks confirm that the working tree is clean, that the current branch is the publish
branch, and that it is in sync with the remote. They exist to stop a local publish of uncommitted
or unpushed work. A tag checkout in GitHub Actions is a detached HEAD, so the branch check cannot
pass there, but the checked-out tree is immutable and the workflow separately proves the commit is
on `master`. The flag is therefore correct in the workflow and remains wrong anywhere else; do not
publish locally.
