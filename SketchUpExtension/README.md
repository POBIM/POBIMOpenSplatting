# POBIM Live Splats SketchUp Bridge

This folder contains a SketchUp extension that opens an `HtmlDialog` with a stacked Three.js + PlayCanvas viewer. The viewer overlays a lightweight proxy mesh exported from the current SketchUp selection with a Gaussian Splat scene (`.ply`/`.splat`) so that both assets share the same camera.

## Installing inside SketchUp

1. Copy the entire `SketchUpExtension` directory into your SketchUp `Plugins` folder (e.g. `~/Library/Application Support/SketchUp 2024/SketchUp/Plugins` on macOS or `%AppData%\SketchUp\SketchUp 2024\SketchUp\Plugins` on Windows).
2. Restart SketchUp and ensure the extension loads. You should see **POBIM Live Splats Bridge** under the **Extensions** menu.

> You can also package the folder as a `.rbz` if you prefer SketchUp's built‑in installer.

## Using the bridge

1. Open your SketchUp model and, if needed, pre‑select the geometry you want to export as the proxy mesh (empty selection exports the full model).
2. Choose **Extensions → POBIM Live Splats Bridge** to open the dialog.
3. Inside the dialog (preview mode):
   - A single canvas renders a lightweight reference grid plus origin axes so you can check how the shared camera is moving.
   - When you click **Reload Mesh (DAE)** the extension re-exports the current SketchUp scene via the native COLLADA (`.dae`) exporter, streams it through the local file server, and the dialog turns it into a simplified wireframe (`Cached • …`) so you can confirm origin/scale quickly.
   - Orbit/pan/zoom in the viewer; the camera stays synchronized with SketchUp's viewport, including ViewObserver updates with a short debounce.
   - Use **Reset View** to snap the preview camera back to its default position and push that pose back into SketchUp if needed.

## Implementation highlights

- Ruby side spins up a scoped WEBrick file server so HtmlDialog assets can fetch heavy `.ply`, `.obj`, and texture files without base64 shuttling.
- Proxy meshes are exported via SketchUp's OBJ exporter into `tmp/pobim-sketchup-bridge_*` folders with automatic cache cleanup.
- Camera data travels as JSON with all positions converted to meters. The SketchUp axes origin (`0,0,0`) is treated as the shared zero so every viewer sees the same reference point.
- The current HtmlDialog preview uses a lightweight 2D canvas renderer with an axes helper plus ground grid. COLLADA exports are parsed on the fly (with a fallback to OBJ) and rendered as simplified wireframes so you can sanity-check scale/origin without the heavier Three.js stack.

Refer to `PobimSketchBridge.rb` if you need to bundle this folder into a `.rbz` later—the entrypoint already follows SketchUp's `SketchupExtension` conventions.
