# OpenDeck Voicemeeter

A Windows plugin for [OpenDeck](https://github.com/nekename/OpenDeck) that controls **Voicemeeter Potato** from Stream Deck-style buttons.

**Latest release:** [v0.2.0](https://github.com/atno11/opendeck-voicemeeter/releases/tag/v0.2.0)  
**Plugin ID:** `dev.atno.voicemeeter.sdPlugin`

## Features

- **Gain Up / Gain Down:** adjust strip gain with a configurable step (0.1–12 dB), within -60 to +12 dB.
- **Mute / Solo / Mono:** toggle each setting on or off.
- **Routing:** toggle A1–A5 or B1–B3 for the selected strip.
- **Eight strips:** five hardware and three virtual strips in Voicemeeter Potato.
- **Visual customization:** independent ON/OFF colors, icon and footer colors, outline, size, position, and custom SVG.
- **Shared visual presets:** save, apply, rename, and delete presets identified by UUID.
- **Automatic preset refresh:** update the preset list when switching between button inspectors or returning to the inspector.
- **Live button images:** reflect the current Voicemeeter state.

Applying a visual preset changes only the appearance of the current button; its strip, gain step, and routing configuration remain unchanged.

## Requirements

- Windows 10 or later
- [OpenDeck](https://github.com/nekename/OpenDeck)
- [Voicemeeter Potato](https://vb-audio.com/Voicemeeter/potato.htm), installed and running
- Node.js runtime support through OpenDeck (the manifest requests Node.js 20)
- Python available on `PATH`, with the `voicemeeter-api` package installed

Install the Python dependency in the Python environment used by the plugin:

```powershell
python -m pip install voicemeeter-api
```

If you use a different Python executable, set the `VOICEMEETER_PYTHON` environment variable for the OpenDeck process.

## Install the release

1. Download [`opendeck-voicemeeter-v0.2.0.zip`](https://github.com/atno11/opendeck-voicemeeter/releases/download/v0.2.0/opendeck-voicemeeter-v0.2.0.zip).
2. Extract the archive. It contains a directory named `dev.atno.voicemeeter.sdPlugin`.
3. Install that plugin directory using your OpenDeck plugin installation workflow.
4. Restart OpenDeck if necessary.
5. Add a Voicemeeter action to a button and select the target strip.

The archive is intended for manual extraction and installation; it is **not** a one-click installer.

> **Breaking change in v0.2.0:** The plugin/action namespace changed from `com.opendeck.voicemeeter` to `dev.atno.voicemeeter`. Existing buttons using the old action IDs may need to be recreated. Do not remove your old installation until the new buttons have been configured and tested.

## Configure a button

Select a Voicemeeter action in OpenDeck, then use its Property Inspector:

| Setting | Purpose |
| --- | --- |
| Strip | Select one of the eight Voicemeeter Potato strips |
| Gain step | Amount changed per press for Gain Up / Gain Down |
| Routing bus | Select A1–A5 or B1–B3 for Routing |
| OFF / ON | Configure the two visual states independently |
| Appearance | Set background, icon, footer, outline, size, and position |
| Custom SVG | Replace the default action icon with a custom SVG |
| Visual Presets | Save, apply, rename, or delete shared appearances |

Custom SVGs are limited to 32 KB and are checked for supported vector elements and unsafe content.

Presets are stored on Windows at:

```text
%APPDATA%\opendeck-voicemeeter\visual-presets.json
```

Each preset has a stable UUID and contains ON/OFF visual styles. Presets are shared across Voicemeeter actions, but applying a preset copies its appearance to one button; it does not create a live link between buttons.

## Build from source

Development requires Node.js and npm, plus Python and the Voicemeeter dependency for running the bridge.

```bash
npm ci
npm run check
npm run build
npm run package -- test
```

The test package is created under:

```text
release/test/test-XXXXXXXX/dev.atno.voicemeeter.sdPlugin/
```

For a production package:

```bash
npm run package -- prod
```

The production output is:

```text
release/dev.atno.voicemeeter.sdPlugin/
```

The packaging script does not overwrite an existing production output directory.

## Architecture

- `src/index.ts` — OpenDeck WebSocket integration, button actions, live images, and visual preset storage.
- `bridge.py` — Python bridge for the Voicemeeter Remote API.
- `ui/inspector.html` — Property Inspector and preset management interface.
- `ui/visual.js` — shared SVG renderer used by the plugin and the Inspector.
- `manifest.json` — OpenDeck action definitions and plugin metadata.
- `scripts/package.sh` — validates, builds, and packages the plugin.

The plugin uses a local Python subprocess to communicate with Voicemeeter running on the **same Windows machine**. Remote-network control is not part of this release.

## Troubleshooting

**Buttons show an offline state:** Check that Voicemeeter Potato is running and Python can import `voicemeeterlib`:

```powershell
python -c "import voicemeeterlib; print('Voicemeeter API OK')"
```

**The preset list looks outdated:** Reopen the button's Inspector or use **Refresh**. The JSON file is the source of truth.

**Old buttons no longer work:** v0.2.0 uses the `dev.atno.voicemeeter` action IDs; create new buttons using the updated plugin.

## Release

See [GitHub Releases](https://github.com/atno11/opendeck-voicemeeter/releases) for published versions and downloadable packages.
