# Release and deployment

A release identifies one reviewed commit, its public site files and the unchanged recorded native evidence. Include the demonstration video, captions and transcript before creating the final signed tag. Repository publication, hosted checks, live acceptance and event submission each require their own observed result.

## What the workflows verify

[`ci.yml`](../.github/workflows/ci.yml) runs on pull requests and when called by the Pages workflow:

| Job | Environment | Evidence |
| --- | --- | --- |
| Node contracts and static build | Node 24, Ubuntu 24.04 and Windows 2025 | Scanner, process, report and site contracts; allowlisted build and immutable evidence checks |
| Launcher controls | Node 24 and PowerShell, Windows 2025 | Owned-client timeouts, output capture and cleanup controls |
| Native Rust contracts | Rust 1.97.0, Ubuntu 24.04 | Locked release tests, formatting and Clippy |

The launcher control job does not start WSL or Zebra. CI does not establish fresh native payment settlement. The [recorded native report](../examples/benchmark-report.html) describes its original dated regtest run; passing CI does not update that evidence. Reproduce full native settlement with the separate [Windows/WSL launcher](../README.md#run-the-native-benchmark).

All external actions use full commit pins. Checkout does not retain credentials, and the dependency-free JavaScript package needs no install step. Rust uses the committed lockfile. This pins source inputs and compiler selection; it does not assert byte-identical native executables across platforms.

[`pages.yml`](../.github/workflows/pages.yml) runs for `main` pushes or manual dispatch. Only `main` can enter its jobs. All checks must succeed before the build, and the build must succeed before deployment. The build has Pages read access; only deployment has Pages write and OpenID Connect permissions. The artifact is the explicit `dist/` allowlist, including `.nojekyll`, never the repository root or runtime directories.

One production concurrency group cancels other active production runs. Immediately before deployment, the workflow also requires the remote `main` SHA to match the workflow SHA. An API failure or stale revision fails closed. An old manual rerun cannot pass this check after `main` advances. GitHub's scheduling and cancellation are asynchronous; after cancellation or a failed stale-revision check, rerun the current `main` revision if it has no successful deployment. A non-main manual dispatch cannot cancel production. Verify the final successful deployment SHA before calling the site released.

## One-time repository setup

Use an owner-authenticated GitHub CLI outside CI. Keep credentials and local operational records out of the repository. Review the complete source history and public artifact for private data before the first push.

Confirm the public repository's default branch is `main`:

```powershell
$releaseRepo = gh repo view --json nameWithOwner --jq .nameWithOwner
gh repo view --json visibility,defaultBranchRef
gh api "repos/$releaseRepo/pages" --jq '{build_type,html_url}'
```

If Pages is not configured, create it with `gh api --method POST "repos/$releaseRepo/pages" -f build_type=workflow`. If an existing Pages site uses another publishing source, use the same arguments with `--method PUT`. Inspect the resulting `build_type`; it must be `workflow`. The workflow deliberately does not try to enable Pages itself.

Configure the `github-pages` environment to allow only the `main` branch. Inspect existing policies before creating a missing one:

```powershell
'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api --method PUT "repos/$releaseRepo/environments/github-pages" --input -
gh api "repos/$releaseRepo/environments/github-pages/deployment-branch-policies"
'{"name":"main","type":"branch"}' |
  gh api --method POST "repos/$releaseRepo/environments/github-pages/deployment-branch-policies" --input -
```

Use a reviewed pull request to land changes. Wait for all checks and the Pages deployment at the intended merge commit. A green pull request run alone does not prove the merged commit is deployed.

## Check a complete release candidate

From a clean checkout of the intended commit, run the same commands as CI:

```powershell
npm test
npm run build:site
pwsh -NoProfile -File ./test/launcher.test.ps1
rustup toolchain install 1.97.0 --profile minimal --component rustfmt --component clippy
$env:RUSTUP_TOOLCHAIN = '1.97.0'
cargo test --locked --release --manifest-path native/Cargo.toml
cargo fmt --manifest-path native/Cargo.toml -- --check
cargo clippy --locked --manifest-path native/Cargo.toml --all-targets -- -D warnings
npm run serve:site -- --base-path /shieldcheck/
```

Inspect the local site at `http://127.0.0.1:4173/shieldcheck/`. Check all three examples, invalid and oversized imports, retained findings for incomplete input, report redaction, keyboard and narrow-screen use, and absence of input-bearing network requests. Verify the video, captions, transcript and links. Repeat browser acceptance against the public HTTPS site without requiring login.

After deployment, compare every public file to the approved local build. Read the site's canonical URL from the Pages API. Download files into a new ignored directory, preserving relative paths, and compare SHA-256 values to the local `dist/` tree. Include the analyzer modules, recorded evidence, video, captions and transcript; HTTP success alone is insufficient. Inspect the successful Pages run's commit and the remote `main` SHA as part of the same verification.

## Create the final signed release

Do this only after the complete source, including demonstration assets, has passed review, hosted checks and live acceptance. If more changes are needed, land and verify those changes before tagging. The commands below use PowerShell and a fresh ignored artifact directory; do not reuse an existing release directory or move an existing tag.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
git fetch origin main --tags
$releaseCommit = (git rev-parse origin/main).Trim()
if ((git rev-parse HEAD).Trim() -ne $releaseCommit) { throw 'Check out the verified main commit first.' }
if (git status --porcelain) { throw 'The source checkout must be clean.' }
$releaseVersion = 'v0.2.0'
$releaseDirectory = Join-Path '.local/release' $releaseVersion
New-Item -ItemType Directory -Path $releaseDirectory -ErrorAction Stop | Out-Null
npm run build:site

git archive --format=zip --output="$releaseDirectory/shieldcheck-$releaseVersion-source.zip" $releaseCommit
$releaseFiles = @(
  'examples/benchmark-report.html', 'examples/benchmark-result.json',
  'examples/chain-evidence.json', 'web/demo.mp4', 'web/demo.vtt',
  'docs/demo-script.md'
)
foreach ($file in $releaseFiles) { Copy-Item -LiteralPath $file -Destination $releaseDirectory }
[IO.File]::WriteAllText((Join-Path $releaseDirectory 'commit.txt'), "$releaseCommit`n", [Text.UTF8Encoding]::new($false))

$siteRoot = (Resolve-Path dist).Path
$siteHashes = Get-ChildItem -LiteralPath $siteRoot -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
  $relative = [IO.Path]::GetRelativePath($siteRoot, $_.FullName).Replace('\', '/')
  '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
}
[IO.File]::WriteAllLines((Join-Path $releaseDirectory 'site-sha256.txt'), [string[]]$siteHashes, [Text.UTF8Encoding]::new($false))

$assetHashes = Get-ChildItem -LiteralPath $releaseDirectory -File | Sort-Object Name | ForEach-Object {
  '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
}
[IO.File]::WriteAllLines((Join-Path $releaseDirectory 'SHA256SUMS.txt'), [string[]]$assetHashes, [Text.UTF8Encoding]::new($false))
git tag -s $releaseVersion $releaseCommit -m "ShieldCheck $releaseVersion"
git verify-tag $releaseVersion
git push origin "refs/tags/$releaseVersion"
gh release create $releaseVersion --verify-tag --draft --title "ShieldCheck $releaseVersion" --notes "Analyzer, offline CLI, recorded native evidence and two-minute demonstration at commit $releaseCommit. Verification boundaries are documented in docs/release.md."
$releaseAssets = (Get-ChildItem -LiteralPath $releaseDirectory -File).FullName
gh release upload $releaseVersion @releaseAssets
```

Download the draft's assets to a different ignored directory and verify every entry in `SHA256SUMS.txt` before publishing:

```powershell
$downloadDirectory = Join-Path '.local/release-verify' $releaseVersion
New-Item -ItemType Directory -Path $downloadDirectory -ErrorAction Stop | Out-Null
gh release download $releaseVersion --dir $downloadDirectory
$localManifest = (Get-FileHash -LiteralPath (Join-Path $releaseDirectory 'SHA256SUMS.txt') -Algorithm SHA256).Hash
$downloadedManifest = (Get-FileHash -LiteralPath (Join-Path $downloadDirectory 'SHA256SUMS.txt') -Algorithm SHA256).Hash
if ($localManifest -cne $downloadedManifest) { throw 'The downloaded manifest differs from the approved manifest.' }
foreach ($line in Get-Content -LiteralPath (Join-Path $downloadDirectory 'SHA256SUMS.txt')) {
  $expected, $name = $line -split '  ', 2
  if ($expected -notmatch '^[0-9a-f]{64}$' -or [IO.Path]::GetFileName($name) -cne $name) { throw 'Invalid checksum entry.' }
  $actual = (Get-FileHash -LiteralPath (Join-Path $downloadDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $expected) { throw "Release asset mismatch: $name" }
}
gh release edit $releaseVersion --draft=false
```

The uploaded source archive is an explicit checksummed asset. Automatically generated GitHub source archives identify the same source revision, but their compressed bytes are not promised to stay identical. Recheck published asset access and hashes without authentication. Preserve the final tag, commit, workflow run, deployment URL and checksum verification in the release record. Keep account contact details and the event's submitted-state receipt private.

## References

- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Pinned artifact upload inputs](https://github.com/actions/upload-pages-artifact/blob/fc324d3547104276b827a68afc52ff2a11cc49c9/action.yml)
- [Source archive stability](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives)
