# Omarchy runtime for DSH

A DSH sidebar plugin for on-demand Linux workspaces. **Version 0.1.0 is an Arch Linux headless preview, not a complete Omarchy desktop.** The virtual-desktop area is a capability placeholder; it does not stream Hyprland or accept remote mouse and keyboard input.

## Install from an open-source repository

1. Download the [v0.1.0 plugin ZIP](https://github.com/zeelinkCN/dsh-omarchy-runtime/releases/download/v0.1.0/dsh-omarchy-runtime-v0.1.0.zip) and extract it (or clone this repository).
2. In DSH, open **Plugins → Add → local bundle** and select the package directory containing `package.json`. DSH installs its manifest and registers the Host and Client components. No `npm install`, build command, or background daemon is needed for the DSH plugin itself.
3. Open **Omarchy runtime** from the left sidebar. Select **Prepare runtime**. The plugin uses an existing Docker or Podman CLI if available. Otherwise it downloads the pinned [Podman v6.1.4 release](https://github.com/containers/podman/releases/tag/v6.1.4), verifies the release SHA-256, and opens the OS installer. Complete any system authorization, then select **Prepare runtime** again to start a dedicated Podman VM and fetch `docker.io/library/archlinux:base`.

This setup downloads an OS installer and Linux image only after the person clicks **Prepare runtime**. It never silently installs system software. macOS uses a `.pkg` installer; Windows uses an `.msi`. Windows may require WSL activation and a restart. The first image pull requires an internet connection. The Arch image is pulled for `linux/amd64`; Apple Silicon and Windows ARM64 require working emulation inside the container engine. On unsupported platforms the plugin still installs but managed engine installation is unavailable.

The repository can be published as a regular git repository or an npm package. It is a self-contained DSH bundle with no npm production dependencies or platform-specific binary checked in. `npm pack --dry-run` verifies release contents. A three-platform GitHub Actions workflow runs syntax checks and unit tests; real Windows/Apple Silicon engine integration still requires hardware validation.

## Controls

- **Top right:** select workspace; power on (`resume`), shut down (`stop`), sleep (`suspend`, implemented as stop), plugin version, and **Upgrade runtime image** (pull latest Arch base image). Updating the plugin itself uses the DSH Plugins page. Existing containers do not change when a newer base image is pulled.
- **Main area:** virtual desktop availability, engine setup, workspace creation, Linux command execution, snapshots, destruction and recent operation history.
- **Bottom:** host platform, Linux guest, configured CPU and RAM limits or sampled live use, disk I/O if the engine supplies it, and network traffic/IP if available. Missing values are marked unavailable; no disk quota is enforced.

Any DSH conversation can use `omarchy_status`, `omarchy_exec` and `omarchy_workspace`. Other Host plugins can declare `omarchy` in `inject`, then call `ctx.omarchy.status()`, `ensureWorkspace({ projectPath, mode })`, `exec({ workspaceId, command, cwd, timeoutSec })`, `suspend(id)`, `resume(id)`, `stop(id)`, `snapshot(id,name)` or `destroy(id)`. The user-only runtime installer and image upgrade are deliberately excluded from agent tools.

`omarchy_exec` executes inside an owned Arch container, with a 2 CPU / 2048 MB default limit, bridge network, a process limit, dropped Linux capabilities and no-new-privileges. Only an explicitly selected project directory is mounted read/write at `/workspace`. Logs hide command text. An empty project path creates a workspace with no host project bind. Shared mode reuses one workspace per project; isolated and ephemeral modes create new workspaces. Idle persistent workspaces are stopped after 10 minutes; ephemeral workspaces are removed after 30 minutes. To change resource values, use the bundle's Host config `cpus`, `memoryMB`, `idleMinutes`, `ephemeralMinutes`, or `dataDir` in a compatible DSH profile composition.

## Known limits

- Containers are not a hardened security boundary. A mounted project path is writable and commands can access the container network.
- Sleep releases RAM by stopping the container; it does not preserve running processes.
- Snapshots capture only the container root filesystem, excluding mounted project files; restore is not supported yet.
- No disk quota, full Omarchy installation, Hyprland desktop, browser stream, clipboard bridge, or genuine live VM graphics are implemented. This remains below the full acceptance criteria in the original product brief.
- Runtime registry is stored in the user's local app data directory under `dsh-omarchy`. Owned containers persist across DSH restarts. Removing the plugin does not remove containers automatically.

The [Try Omarchy project](https://github.com/omacom/try-omarchy) provides a full Omarchy ARM VM for Apple Silicon, but it does not establish a common remotely embedded desktop backend for both macOS and Windows. A later release needs a documented guest image/license, guest control channel, verified cross-platform virtualization, authenticated low-latency streaming and input support before the virtual desktop can be enabled.

## Development

Requires Node.js 22+ and DSH 0.2.2-rc.1-compatible plugin APIs. Run `npm run check` and `npm test` from this directory. No machine-level container engine is used in unit tests. Source code and original icon are licensed under [MIT](LICENSE). Podman, Arch Linux, Omarchy and Try Omarchy retain their own licenses and trademarks; their binaries and marks are not included in this package.
