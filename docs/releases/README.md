# Release process

GitHub Releases are created from version tags by
`.github/workflows/release.yml`. The workflow verifies the tag, builds the
Windows installer, and creates a draft release. It never publishes the draft
automatically.

## Prepare a release

1. Create a non-`master` release branch.
2. Update `package.json` and `package-lock.json` with
   `npm version <version> --no-git-tag-version`.
3. Add `docs/releases/v<version>.md`. Write for users: lead with upgrade
   implications, then summarize features, fixes, and known limitations.
4. Run `npm run verify`, merge the verified release branch, and update local
   `master` with `git pull --ff-only`.
5. Create and push an annotated tag:

   ```powershell
   git tag -a v<version> -m "v<version>"
   git push origin v<version>
   ```

The release workflow rejects a tag whose version differs from `package.json`
or whose notes file is missing. Tag pushes do not start the ordinary CI
workflow, because the release workflow runs the same `npm run verify` gate.

## Review and publish

After the Release workflow succeeds, inspect the draft and its installer:

```powershell
gh release view v<version> --web
```

Update the draft body when necessary:

```powershell
gh release edit v<version> --notes-file docs/releases/v<version>.md
```

Publish only after the notes and installer have been checked:

```powershell
gh release edit v<version> --draft=false --latest
```

Do not run `gh release create` for a normal release; the tag workflow owns
draft creation and installer upload. Re-running a failed Release workflow
updates the existing draft for that tag.
