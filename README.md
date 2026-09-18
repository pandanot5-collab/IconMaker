i# Icon Maker

Pick a model in Roblox Studio, then frame it, add outlines and grade the colors in a desktop app. Export it as a PNG icon.

## Setup
1. **Plugin:** copy `plugin/IconMakerSync.lua` into `%LOCALAPPDATA%\Roblox\Plugins`, then restart Studio. When Studio asks, allow HTTP requests to `127.0.0.1`.
2. **App:** double-click `Start Icon Maker.bat` (it needs Node.js). To build a standalone portable `.exe`, run `cd app && npm run dist`.

## Use
- The **Icon Maker** toolbar has two buttons. **Live Sync** sends every selection to the app. **Send** sends the current selection once.
- The red box is the exported image.
- Mouse controls:
  - Drag to rotate.
  - Shift+drag to roll.
  - Right-drag to move.
  - Scroll the wheel to zoom.
- The rotation, zoom, FOV and all other settings persist. Every new model you select is centered and fitted into the same frame, with the same angle.
- Turn off **Auto-fit** to keep the models' real sizes relative to each other.
- **Outlines** stack from the model outward. Each one has its own color, thickness and opacity.
- **Adjustments:** brightness, contrast, saturation and light.
- **Export:** 128–2048 px PNG, with a transparent or solid-color background, saved to a file or copied to the clipboard.

## Assets (meshes, SurfaceAppearance, textures, decals)
The plugin reads mesh and texture data directly (EditableMesh/EditableImage) for assets you have permission to use. Roblox blocks that for assets owned by other creators. For those, the app downloads the asset itself, and Roblox requires you to be signed in for that. Under **Asset download settings**, enter either an Open Cloud API key (with the legacy-assets read permission) or your `.ROBLOSECURITY` cookie.

Unions can't be read by plugins. Convert them to MeshParts.
