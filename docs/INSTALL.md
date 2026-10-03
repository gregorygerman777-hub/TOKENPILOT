# Install TokenPilot 1.2.1

Supported prebuilt release: macOS on Apple Silicon. The desktop runtime and CLI runtime are bundled; Node and npm are not required for this installation.

```sh
curl -fsSL https://github.com/gregorygerman777-hub/TOKENPILOT/releases/download/v1.2.1/install.sh | sh
```

[Read the script](../scripts/install.sh) first if you prefer. It checks the ZIP's SHA-256, verifies the app's identifier/version, installs `~/Applications/TokenPilot.app`, adds `~/.local/bin/tokenpilot`, and opens the app. It adds the CLI directory to `.zprofile` or `.bash_profile` for those shells. Other shells need that directory added manually. Restart Terminal after installation. No sudo, automatic scanner installation, or removal of macOS security attributes is performed. A previous TokenPilot app is retained as a timestamped backup; unrelated commands and symlinks are not overwritten.

```sh
brew install semgrep gitleaks
tokenpilot status
tokenpilot serve
```

Open the localhost URL printed by `serve`; keep Terminal running. You can also launch the desktop using `tokenpilot open`. `status` reports local scanner and Docker availability; it is not a daemon status command.

The build is unsigned and not notarized. macOS may block its first launch. Review the app in System Settings > Privacy & Security and allow it only if you trust this release. The installer cannot guarantee unattended first launch.

The DMG is an alternative desktop-only installation: drag TokenPilot into Applications. The one-line installer additionally sets up the CLI. Do not mix the two locations when upgrading.

Local scans require Semgrep and Gitleaks but no AI account. AI repair requires Claude Code and your provider sign-in; batch repair also requires Git and a clean committed repository. Docker is only needed for the optional probe adapter, whose live execution is not validated. No independent AI Challenger is included.

## Source and Claude plugin

Download the source ZIP and open Terminal in the extracted TokenPilot folder. Use Node 24 and npm:

```sh
npm ci
npm run web
# Or launch the desktop:
npm start
```

For the Claude Code plugin, run `Open TokenPilot in Claude.command` from that source folder. The binary installer does not globally register a Claude plugin.

## Offline install and checksums

Download the app ZIP and installer from the same release, then:

```sh
sh install.sh --archive TokenPilot-1.2.1-arm64-mac.zip
```

`--no-open` skips opening the app. `--no-path` skips shell-profile changes. `--prefix /absolute/directory` installs into a separate root and skips profile changes. These options are also used by the installer integration test.

Checksums detect corrupted or unexpected downloads; they are not a code-signing identity. Keep local scan data in Application Support when removing or upgrading the app.

Intel Mac, Windows and Linux prebuilt desktop downloads are not available in this release.
