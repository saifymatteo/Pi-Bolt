# Publishing a private macOS build in this fork

The `saifymatteo/Pi-Bolt` native publisher normally requires successful Linux,
Windows and macOS artifacts from one Actions run. Its explicit `local-macos`
mode replaces only the macOS CI artifact with a maintainer-authenticated private
build. Linux and Windows still require successful jobs from the same source
commit, run and artifact attempts. Ordinary tag releases and CI-only promotions
are unchanged.

No runner registration or connection from GitHub to the build machine is needed.
Transfer the result to the maintainer's machine over the existing private SSH
connection. Keep the release key in GitHub CI and the build-record signing key
in the maintainer's agent, not on the build machine.

## Build and review

1. Check out the exact signed release commit, including Git metadata. Verify the
   downloaded upstream runtime signature, checksum and adjacent stamp before
   building. Never replace its stamp with the expected value.
2. Run the artifact workflow's preparation, packaging contracts, focused source
   tests, terminal tests, JIT-on build, native regressions and identity/image smoke
   checks. Also test offline repair, repeated repair, deletion recovery, upstream
   Pi preference and doctor diagnostics against the unpacked archive.
3. Package the entire runtime under `pi-bolt-darwin-arm64-jit/`. Retrieve the archive,
   build log and metadata privately; verify the transfer's checksums.

On macOS, use a portable official Node binary for the packaging contracts: their
argument-forwarding fixture copies Node. Homebrew's shared-library Node cannot
run from that copied location. The build also needs current Python and Bash 4.4+.

## Authenticate the build record

Write `build-metadata.json` with these fields. Commit and tree are the exact
release source (`git rev-parse HEAD` and `git rev-parse 'HEAD^{tree}'`). Archive
hashes are SHA-256; `runtimeSha256` hashes the verified Bun binary used to compile.
The record must contain no `runId`, `runAttempt`, `ref` or `sha` CI claims.

```json
{
  "schemaVersion": 1,
  "buildType": "ssh-local",
  "repository": "saifymatteo/Pi-Bolt",
  "sourceCommit": "<release commit>",
  "sourceTree": "<release tree>",
  "sourceArchiveSha256": "<source snapshot checksum>",
  "platform": "darwin-arm64",
  "boltVersion": "<VERSION>",
  "jit": "on",
  "runtimeRepository": "opensec-git/Pi-Bolt",
  "runtimeTag": "bolt-v1.1.7",
  "runtimeStamp": "<verified adjacent stamp>",
  "runtimeSha256": "<Bun checksum>",
  "archiveSha256": "<release archive checksum>",
  "checksPassed": [
    "signed runtime stamp gate",
    "offline source build",
    "workflow and packaging contracts",
    "focused source regressions",
    "terminal submission regressions",
    "native Pi regressions",
    "canonical identity, compiled image, argv, and image worker smoke",
    "offline launcher repair, idempotence, deletion recovery, upstream preference, and doctor diagnostics"
  ]
}
```

After reviewing the actual build log, sign the record with the key pinned in
`keys/pi-native-local-build.allowed-signers`:

```bash
ssh-keygen -Y sign -n pi-bolt-native-build -f /path/to/signing-key.pub build-metadata.json
GITHUB_REPOSITORY=saifymatteo/Pi-Bolt PI_NATIVE_RUNTIME_TAG=bolt-v1.1.7 \
  node scripts/pi-native-local-build.mjs /path/to/artifacts /path/to/release-checkout \
  keys/pi-native-local-build.allowed-signers
```

The public-key path lets `ssh-keygen` use the private key held by an SSH agent.
The signature authenticates the maintainer's statement and exact archive, not
independent proof of compilation or test execution. Only attest to checks actually
reviewed. Changing the trusted builder key requires a reviewed publisher commit.

## Stage and publish

1. Create an immutable release tag at the source commit. Do not move an existing tag.
2. Create a **draft**, not a public release, named `pi-native-local-macos-<version>`
   with `--target <full source commit>`. Upload exactly
   `pi-bolt-darwin-arm64-jit.tar.gz`, `build-metadata.json` and `build-metadata.json.sig`.
3. Find the draft's numeric release ID with `gh api repos/saifymatteo/Pi-Bolt/releases`.
   Dispatch the publisher from its reviewed `pi-bolt` commit:

   ```bash
   gh workflow run pi-native-artifacts.yml -R saifymatteo/Pi-Bolt --ref pi-bolt \
     -f source_run_id=<CI run> -f release_tag=pi-native-v<version> \
     -f local_macos_release=<numeric-draft-release-ID>
   ```

The intake input is an ID, not a tag: GitHub's by-tag API omits draft releases.
The publisher resolves the same-repository draft by ID, validates the exact source
commit and exactly three uploaded fixed-name assets, then downloads their IDs.

The source run must be completed and match the immutable tag. Its overall result
may be failure or cancellation, but both Linux and Windows artifact attempts
must have successful matching CI jobs. The publisher checks the draft's source,
the builder signature, source commit/tree, version, runtime stamp, required check
statements and actual archive hash before release signing. Missing or mismatched
data fails closed.

The final release identifies macOS as SSH-local, publishes its unchanged signed
record and builder signature, and includes both in the release-key-signed
checksums. It does not invent an Actions build identity. Delete the intake draft
after verifying the published release; retain the private build log locally.
