# PobimSplatting Frontend

This frontend is the operator UI for the reconstruction pipeline. It is not a generic Next.js starter anymore.

It provides the upload surface, project list, project detail page, stage-level retry controls, live logs, camera-pose inspection, gaussian viewer, and mesh export entrypoints for the backend pipeline.

## What Lives Here

- App Router pages under `src/app/`
- Shared UI components under `src/components/`
- Shared REST client in `src/lib/api.ts`
- Shared realtime client in `src/lib/websocket.ts`
- SfM/matcher display helpers in `src/lib/sfm-display.ts`

## Main Routes

| Route | Role |
|------|------|
| `/` | Dashboard and system summary |
| `/upload` | Upload entrypoint |
| `/projects` | Project backlog and status |
| `/projects/[id]` | Main pipeline control surface |
| `/processing/[id]` | Alias for project detail |
| `/viewer` | Gaussian splat viewer |
| `/camera-poses/[id]` | Sparse reconstruction inspection |
| `/settings` | Runtime configuration surface |

## Frontend Responsibilities In The Pipeline

- Collect upload and retry parameters
- Show policy previews before processing
- Render live stage progress and log streams over Socket.IO
- Surface the selected SfM engine, feature method, and matcher mode
- Jump users into viewer, camera poses, and mesh export workflows
- Proxy some backend operations through Next route handlers where needed

## Stable Run Modes

Production-style local run:

```bash
npm run build
npm run start
```

Hot-reload development:

```bash
npm run dev
```

The launcher flow for the whole product assumes the production-style path, not a permanent dev server.

## Environment

```env
NEXT_PUBLIC_API_URL=http://localhost:5000
NEXT_PUBLIC_WS_URL=http://localhost:5000
```

## Key Files

- `src/app/projects/[id]/page.tsx`: project pipeline page
- `src/app/viewer/page.tsx`: splat viewer route
- `src/app/camera-poses/[id]/page.tsx`: sparse pose inspector
- `src/components/MeshExportPanel.tsx`: textured mesh actions
- `src/components/SplatViewer.tsx`: viewer shell
- `src/lib/api.ts`: typed API client
- `src/lib/websocket.ts`: realtime client

## Validation

The primary frontend validation in this repo is:

```bash
npm run build
```

Then run the app and verify the main routes against a live backend.
