# Ternline website

The Signal landing page, implemented as a static Astro site with Tailwind CSS and TypeScript.

From the repository root:

```sh
pnpm install
pnpm --filter @ternline/website dev
pnpm --filter @ternline/website typecheck
pnpm --filter @ternline/website build
pnpm --filter @ternline/website preview
```

The static output is `apps/website/dist`. This app does not use the desktop build, a database, or any containers.

The page uses the approved Signal direction in `docs/design/website-variants.html`. Its unchanged app screenshot shows fictional projects and a local browser demo, captured on 2 October 2026. Documentation links are pinned to the PR #18 source revision used for that design; update them when the product documentation moves to the main branch.
