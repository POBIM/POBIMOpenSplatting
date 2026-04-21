# FRONTEND KNOWLEDGE BASE

## OVERVIEW
Next.js 16 App Router frontend for the POBIM web platform, with shared REST/WebSocket client layers and a production-first launcher flow.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Page routing | `src/app/` | App Router pages: `/`, `/upload`, `/projects`, `/projects/[id]`, `/processing/[id]`, `/viewer`, `/markers`, `/camera-poses/[id]`, `/settings` |
| Server-side API proxy | `src/app/api/*` | Next route handlers that proxy backend calls (coexists with client-side Axios) |
| Shared UI | `src/components/` | PascalCase components (`SplatViewer`, `ProjectCard`, `MeshExportPanel`, `Navbar`) |
| Viewer internals | `src/components/splat-viewer/`, `point-editor/`, `measurement/` | heaviest local complexity; subfolder name is domain/kebab, files inside follow `use*`/PascalCase |
| Backend client | `src/lib/api.ts` | Axios client + typed endpoint helpers |
| Realtime client | `src/lib/websocket.ts` | singleton Socket.IO client, events keyed by `project_id` rooms |
| UI formatters | `src/lib/sfm-display.ts` | SFM/matcher engine label helpers |
| Build/runtime config | `package.json`, `next.config.ts`, `tsconfig.json` | Next 16 behavior, `@/* -> ./src/*` alias, `/api/:path*` rewrite to backend |

## CONVENTIONS
- Stable local run for launcher parity is `npm run build && npm run start`; use `npm run dev` only for hot-reload development.
- API base URL and websocket URL come from `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` env vars, with `http://localhost:5000` fallback.
- Server communication goes through `src/lib/api.ts` and `src/lib/websocket.ts`, not ad hoc fetch/socket setup in components.
- Styling is Tailwind 4 via `src/app/globals.css` and CSS variables - there is intentionally no `tailwind.config.*`.
- Component filenames are PascalCase; feature subfolders under `components/` are lowercase/kebab domain names; hooks follow `use*`.
- Interactive pages/components use `"use client"` explicitly.
- Stack is React 19 + Next 16 + Tailwind 4 + TypeScript.

## ANTI-PATTERNS
- Do not add duplicate HTTP clients or socket wrappers outside `src/lib/` unless there is a compelling boundary.
- Do not assume a test runner exists; validation here is mainly `npm run build` plus manual app checks.
- Do not regress back to dev-server-only assumptions; launcher and docs are aligned around build-then-start.
- Do not couple components to hardcoded backend URLs when env-based config already exists.
- Do not add a `tailwind.config.*` file - Tailwind 4 is driven from `globals.css` here.

## COMMANDS
```bash
npm install
npm run build
npm run start

# local hot reload only
npm run dev
```

## NOTES
- No child AGENTS below `src/`; the viewer subtree (`splat-viewer/`, `point-editor/`, `measurement/`) is complex but cohesive enough that one frontend guide suffices.
- Both Next route handlers (`src/app/api/*`) and client Axios coexist - prefer the shared `src/lib/api.ts` client for new feature work.
- `/processing/[id]` is an alias that reuses the project detail page; changes to live state flow should be made there.
