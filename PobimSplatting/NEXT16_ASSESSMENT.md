# Next 16 Assessment for PobimSplatting

## Current Status

- Frontend is now on `next@16.2.1`, `react@19.2.4`, and `react-dom@19.2.4`
- Frontend build works on Node 24; deployment and CI should keep a Node 20.9+ baseline for Next 16
- App Router is in use throughout `src/app/`
- Dynamic route handlers already use async `params: Promise<...>` in the `app/api/projects/[id]/*` routes
- No `pages/` router, `getServerSideProps`, or `next/router` usage was found in the assessed files

## What Looks Ready

- React 19 baseline is already in place
- Tailwind CSS v4 is already in place
- `next.config.ts` usage is already modern and now pins `outputFileTracingRoot` so workspace root inference is deterministic
- Dynamic API routes under `src/app/api/projects/[id]/` are already aligned with the async params model that Next 16 enforces
- The orphan parent lockfile that triggered the Next workspace warning has been removed, leaving `Frontend/package-lock.json` as the canonical lockfile

## Main Migration Surface

### 1. Async request APIs

Next 16 removes the temporary synchronous fallbacks from Next 15. Code that touches `params`, `searchParams`, `headers()`, `cookies()`, or `draftMode()` must use the async form.

Current repo impact appears low:

- `src/app/api/projects/[id]/route.ts` already awaits `params`
- `src/app/api/projects/[id]/available_exports/route.ts` already awaits `params`
- `src/app/api/projects/[id]/create_textured_mesh/route.ts` already awaits `params`
- Client-side pages such as `src/app/projects/[id]/page.tsx` use `useParams()` from `next/navigation`, which is unaffected by the server-side async request API change

### 2. Caching behavior

Next 16 continues the shift toward explicit caching. There is no urgent blocker in the assessed files, but any route-level caching assumptions should be rechecked during the actual upgrade.

### 3. Dev/build defaults

Turbopack is the default path in newer Next releases. The current scripts are simple (`next dev`, `next build`, `next start`), so there is no obvious script migration burden.

### 4. Node baseline

Next 16 expects a modern Node baseline. This frontend already builds on Node 24, so deployment and CI should stay on Node 20.9+ or newer.

## Low-Risk Cleanup Already Identified

- The previous unused `next/image` import in `src/components/ProjectCard.tsx` has already been removed.

## Upgrade Outcome

1. The frontend has been upgraded to Next 16 successfully
2. `Frontend/package-lock.json` is now the canonical lockfile and the stray parent lockfile has been removed
3. `next.config.ts` now pins `outputFileTracingRoot` so workspace root inference is deterministic
4. The current App Router request API usage remains compatible with Next 16
5. `npm run build` and `npx tsc --noEmit` pass after the upgrade

## Remaining Follow-Up

1. Keep deployment/CI on Node 20.9+ or newer
2. Re-audit server-side request APIs (`params`, `searchParams`, `headers`, `cookies`) whenever new routes are added
3. Revisit `next.config.ts` only if a future Next release changes config module semantics around `__dirname`

## Recommendation

The frontend is now **successfully running on Next 16**. The upgrade path was low-risk for this repo because the App Router, React 19 baseline, and async route params were already in place.
