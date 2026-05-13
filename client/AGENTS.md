# AGENTS.md — client/

Frontend for Corolla Fix Helper. Inherits the root `AGENTS.md`; this
file adds frontend-specific guidance.

## Stack

- React 19 + React Router 7
- Vite 7 (dev + build)
- Tailwind CSS 4 (via `@tailwindcss/postcss`)
- Tests: Vitest + Testing Library + jsdom

## Layout

```
client/
├── index.html
├── vite.config.js
├── postcss.config.js
├── public/
└── src/
    ├── main.jsx          Entry — mounts <App />
    ├── App.jsx           Router + layout shell
    ├── index.css         Tailwind entry
    ├── components/       Reusable UI (PageHeader, Sidebar, …)
    ├── pages/            One folder-equivalent per route + colocated tests
    ├── lib/              Pure helpers (navigation, suggestionUtils)
    └── test/             Shared test setup / utilities
```

Route ↔ page mapping lives in `src/lib/navigation.js`. Add new
navigation entries there, not inline in `Sidebar.jsx`.

## Commands

- `npm run dev` — Vite dev server on `http://localhost:5173`. Expects
  the backend on `4000` (see root `AGENTS.md`).
- `npm run build` — Production build to `dist/`.
- `npm run preview` — Serve the built bundle.
- `npm test` — Vitest, single run (CI mode).

## Conventions

- **One page = one file** in `src/pages/`, with a sibling
  `*.test.jsx` (see existing pages for the pattern).
- **Components in `src/components/`** stay presentational and reusable.
  Anything page-specific lives in the page file.
- **Styling**: Tailwind utility classes. Avoid adding global CSS to
  `index.css` unless it's a true reset/base rule.
- **Data fetching**: hit the backend at relative `/api/...` paths so the
  Vite dev proxy / production reverse proxy can route them.
- **Routing**: use `react-router-dom` v7 idioms (`<Routes>`, hooks).

## Testing

- Render with Testing Library; query by role/text, not by class.
- Mock `fetch` at the test boundary; don't pull in MSW unless we agree
  to take that dependency.
- Keep tests colocated next to the page/component they cover.

## Don't

- Don't add a state management library (Redux, Zustand, etc.) — local
  component state + router state is sufficient for V1.
- Don't introduce a UI kit (MUI, Chakra) — Tailwind only.
- Don't fetch directly from `localhost:4000` in code; use relative paths.
