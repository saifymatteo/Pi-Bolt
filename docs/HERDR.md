# Experimental Pi identity for Herdr on Windows

Stock Herdr versions that recognize Pi but not Pi-Bolt can reject reply-review
feedback even when the review opens. Herdr validates both the agent report and
the foreground process; changing only the reported label is insufficient.

`--herdr-as-pi` is an opt-in Windows prototype. It requires a **native Pi-Bolt
build containing this change** ([build guide](BUILDING.md)); running the
TypeScript CLI with Node is not supported. It does not patch Herdr or Plannotator, install an alias, change PATH,
or replace your existing `pi` command.

## Start a session

Inside a Herdr pane, with the new native build available as `pi-bolt`:

```powershell
pi-bolt --herdr-as-pi
pi-bolt --herdr-as-pi --session "D:\Projects\example\session.jsonl"
```

Normal `pi-bolt` invocation keeps its current identity and behavior.

The compatibility invocation:

1. Copies the executable and its complete adjacent runtime directory into a
   unique `%TEMP%\pi-bolt-herdr-*` directory, including themes, native helpers,
   and Photon WASM. A separate `PI_PACKAGE_DIR` asset override is not supported.
2. Runs a byte-identical native `pi.exe` from that private directory, with
   inherited console input/output and unchanged PATH. The waiting parent does
   not enter an agent session.
3. Registers the exact transcript with Herdr's `pane.report_agent_session`
   protocol before publishing lifecycle state as `agent: pi`, `source: herdr:pi`.
   Herdr requires that registration to accept canonical Pi state and resume
   metadata. Pi-Bolt branding, data, and transcript format remain unchanged.
   Competing Pi reporters stay suppressed.
4. Removes the temporary runtime when the child exits. Every new invocation
   copies fresh bytes instead of retaining an alias across updates or rollback.

The initial copy and Windows scanning of a new image add startup time and disk
usage; the waiting parent also uses memory. This is a correctness prototype,
not a startup-performance improvement.

## Resume after a Herdr restart

Use a PowerShell-backed Herdr pane for restart/resume. Stock Herdr 0.9.5 renders
resume arguments with single quotes; `cmd.exe` treats those quotes literally
and cannot reopen the transcript correctly. This prototype does not change
Herdr's shell quoting.

The reported resume command is:

```text
pi-bolt --herdr-as-pi --session <absolute transcript path>
```

Herdr 0.9.5 requires a **plain command name** as the first argument, so reporting
an absolute path to the private `pi.exe` would be rejected. The compatibility
flag survives in the resume command and creates a fresh private runtime.
If the transcript cannot safely fit in Herdr's argv (for example an apostrophe
in its path), the reported command uses `--resume` to open Pi-Bolt's session
picker instead. It must never fall back to stock Pi's built-in resume command.

The `pi-bolt` command on Herdr's restored PATH must resolve to a build containing
this feature. Launching a test build by absolute path does **not** upgrade that
command. Installing such a build is a separate deployment step.

## Prototype limits

- Windows native builds only; there is no macOS/Linux compatibility entrypoint.
- Only interactive sessions report state. Print, JSON, RPC and other headless
  sessions must not take over the pane's agent report. Keep `builtin:herdr`
  enabled; disabling extensions also disables its session/resume reporting.
- Self-update, channel changes, rollback and compilation are rejected inside
  the temporary process. Run them using the original installation outside this
  mode, respecting its package manager. Extension/model updates remain available.
- Do not update or roll back the source installation while the initial snapshot
  is being copied. A changed executable is detected, but the copy is not an
  atomic filesystem snapshot. Once running, the private assets are independent.
- Forced parent termination can leave a temporary runtime behind. After all
  related processes exit, remove only that invocation's `pi-bolt-herdr-*` folder.
  Cleanup failures print the exact directory.

## Verification boundary

Run the focused offline checks from the repository root:

```sh
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/herdr-pi-compat.test.ts test/herdr-extension.test.ts test/package-manager-cli-preflight.test.ts
```

Offline tests cover report identity, lifecycle, exact-session metadata, resume
arguments, private image naming, asset copying, failure cleanup, fresh copies
across source changes, and installation-changing command guards. The Windows
image test uses a local native Node executable as a fixture; it is not an
end-to-end Pi-Bolt/Herdr delivery test.

An isolated Windows native run passed 29 checks against stock Herdr 0.9.5 and
Plannotator TUI 0.9.9: exact reply selection, feedback delivery, blocked-dialog
and wrong-foreground rejection, and restart/resume into the same transcript
using a fresh private `pi.exe`. The test used a disposable Annotate-compatible
plugin fixture, a profile-free PowerShell shell bound to the prototype, and a
local scripted model. It did not exercise the installed full Annotate package.

A startup timing issue remains unresolved. If registration and initial state
both arrive before Herdr detects the Pi process, Herdr can acknowledge and
buffer them without retaining the supplied resume command. Later process
detection activates the state but does not replay that command. A normal
pre-prompt persistence check passed, but did not force this ordering. Add a
deterministic delayed-detection regression and acceptance recovery before
deployment; successful RPC acknowledgment alone does not establish readiness.
Do not install this prototype on the strength of the happy-path checks alone.
