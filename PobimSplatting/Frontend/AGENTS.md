# FRONTEND KNOWLEDGE BASE

## OVERVIEW
Next.js 16 App Router frontend for the POBIM web platform, with shared REST/WebSocket client layers and a production-first launcher flow.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Page routing | `src/app/` | App Router pages and route handlers |
| Shared UI | `src/components/` | reusable panels/cards/viewer UI |
| Backend client | `src/lib/api.ts` | central Axios client + API types |
| Realtime client | `src/lib/websocket.ts` | singleton Socket.IO client |
| Build/runtime config | `package.json`, `next.config.ts`, `tsconfig.json` | Next 16 behavior and scripts |

## STRUCTURE
```text
Frontend/
├── src/app/
├── src/components/
├── src/lib/
├── public/
├── package.json
└── next.config.ts
```

## CONVENTIONS
- Stable local run for launcher parity is `npm run build && npm run start`; use `npm run dev` only for hot-reload development.
- API base URL and websocket URL come from `NEXT_PUBLIC_*` env vars, with localhost fallbacks.
- Shared server communication should go through `src/lib/api.ts` and `src/lib/websocket.ts`, not ad hoc fetch/socket setup in components.
- Stack expectations here are React 19 + Next 16 + Tailwind 4 + TypeScript.

## ANTI-PATTERNS
- Do not add duplicate HTTP clients or socket wrappers outside `src/lib/` unless there is a compelling boundary.
- Do not assume a test runner exists; validation here is mainly `npm run build` plus manual app checks.
- Do not regress back to dev-server-only assumptions; launcher and docs are aligned around build-then-start.
- Do not couple components to hardcoded backend URLs when env-based config already exists.

## COMMANDS
```bash
npm install
npm run build
npm run start

# local hot reload only
npm run dev
```

## NOTES
- This subtree intentionally has no separate child AGENTS below `src/`; component and app conventions are still simple enough for one frontend guide.
- The heaviest local complexity lives in `src/components/splat-viewer/` and the shared client layer.
