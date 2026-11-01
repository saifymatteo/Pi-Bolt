# Using Pi-Bolt with Herdr

Keep the two commands separate:

- **`pi`** remains your original Node-based Pi installation.
- **`pi-bolt`** starts this fork's compiled runtime. No `--herdr-as-pi` flag is needed.

The public `pi-bolt` launcher starts a privately stored Pi-named engine so stock
Herdr recognizes its process. It does not replace the global `pi` command, copy a
temporary runtime, or enable a separate compatibility mode. Both versions use Pi's
normal configuration and sessions under `~/.pi/agent` unless you override that path.

The startup hint remains:

> Pi-Bolt can explain its own features and look up its docs. Ask it how to use or extend Pi-Bolt.

## Get a test build

The fork's **Pi native artifacts** Actions workflow targets Windows x64 and macOS
Apple Silicon, including M2. Two ways to get a build from `saifymatteo/Pi-Bolt`:

- **Release (recommended):** pushing a `pi-native-v*` tag builds both platforms and
  publishes a GitHub release at that tag with the archives, a combined LF
  `SHA256SUMS`, per-platform build metadata, and the installer scripts. Tags with a
  `-trial` suffix publish as prereleases; plain tags are full releases marked Latest.
- **CI artifact:** every push to `feat/pi-native-identity` uploads per-platform
  artifacts to the workflow run, kept for 14 days.

Extract the **complete archive** into its own directory. The public command is
`pi-bolt.cmd` on Windows or `pi-bolt` on macOS. Keep its private `runtime` directory
and all adjacent assets intact; copying just an executable is insufficient. Verify
first with `sha256sum -c SHA256SUMS`. The releases also carry `install.ps1` /
`install.sh`, which download, verify, and install the `pi-bolt` launcher for you
without touching Node `pi`.

These are trial builds, not installers. Extracting one does not replace installed
Pi or change PATH. A macOS archive is not notarized; Gatekeeper may block
downloaded code. Assess the artifact before changing its quarantine attributes;
the workflow does not remove quarantine for you.

## Try feedback in a new pane

1. Open a **new** Herdr pane. On Windows, use PowerShell rather than `cmd.exe`.
2. Run the extracted command by its full path:

   ```powershell
   & "D:\path\to\extracted-build\pi-bolt.cmd"
   ```

   On macOS:

   ```sh
   /path/to/extracted-build/pi-bolt
   ```

3. Ask: `Reply exactly: HERDR TRIAL OK. Do not use tools.`
4. Open that reply with Herdr Annotate. Add:
   `Reply exactly: ANNOTATION RECEIVED. Do not use tools.`
5. Press **Shift+S**. The turn should start automatically and answer
   `ANNOTATION RECEIVED`, without manually pressing Enter in the agent editor.

This uses your normal Pi configuration and can incur normal provider charges.
Keep `builtin:herdr` enabled; disabling all extensions also disables its reporter.
The earlier prototype worked with stock Herdr and Plannotator, without patches to
those applications. The rebased artifacts still require their own validation.

## Restart is deferred for these trial artifacts

**Do not rely on Herdr restoring a session into the compiled runtime yet.** The
current reporter uses canonical Pi metadata, so Herdr can restore it with
`pi --session <transcript>` and select your original Node Pi. Keeping `pi` and
`pi-bolt` separate does not change that default.

Herdr 0.9.5 can acknowledge a custom restart instruction without retaining it;
its public API does not expose the retained command for verification. These trial
artifacts deliberately do not claim that compiled-session restart is solved.
Opening replies and sending feedback can be tested independently of restart.

After a restart, exit a restored Node Pi before manually reopening the same
transcript with `pi-bolt --session <transcript>`. Do not run both versions against
the same transcript simultaneously. A future reliable restart implementation must
preserve the `pi-bolt` command without taking over global `pi`.

**Do not restart your working Herdr session merely to test an extracted artifact.**
Windows restart trials also require PowerShell: Herdr 0.9.5 uses single-quoted
resume arguments that `cmd.exe` does not interpret correctly.

The built-in reporter registers the exact transcript using
`pane.report_agent_session` before publishing lifecycle state with `agent: pi` and
`source: herdr:pi`. Only interactive sessions own the pane; print, RPC, JSON, and
subagent runs do not. Competing Pi reporters remain suppressed.

## Updates and verification

Application update URLs point to **`saifymatteo/Pi-Bolt`**, not upstream. A
`pi-native-v*` release carries `install.ps1` / `install.sh`, its archives, and a
`SHA256SUMS` whose first line names the version and whose Ed25519 signature
(`SHA256SUMS.sig`, signed in CI by the `PI_NATIVE_RELEASE_KEY` secret; the matching
public key is `keys/pi-native-release.pub`, also built into the executable) covers
the installers and archives. The TUI's update notice and `pi-bolt update` resolve
this fork's `pi-native-v*` tags, including `-trial` prereleases on the beta channel.
Compiler-runtime downloads still use verified upstream releases; they are not
application updates.

Release archives carry one variant folder (`pi-bolt-win32-x64-jit/` with the private
`pi.exe`, or `pi-bolt-darwin-arm64-jit/` with its `pi` launcher and `pi-bin`); the
installers lay that folder into `~/.pi-bolt` and link the public `pi-bolt` shim to
it, keeping the replaced build beside it as `<folder>.previous` for `--rollback`.

Useful source checks, from the repository root:

```sh
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/config-pi-identity.test.ts test/herdr-extension.test.ts test/package-manager-cli-preflight.test.ts
```

The earlier Windows prototype passed isolated stock-Herdr/Plannotator round-trip
and restart checks. Its held-Shift submission fix also passed a live user trial.
Those results establish a baseline, **not** validation of the newly rebased Windows
build or the macOS artifact. Check each Actions run's tests and artifact metadata.

For native compilation details, see [Building](BUILDING.md) and
[Architecture](ARCHITECTURE.md).
