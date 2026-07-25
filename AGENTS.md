# Repository Rules

## Production UI Visual Baseline

- Current live Production at `https://www.growuppilot.com`, the screenshots, the manifest, and the recorded live asset hashes are the oldest acceptable UI state.
- Visual-baseline tags such as `ui-visual-baseline-current` and `ui-visual-baseline-production-20260725` must never be checked out, restored, merged, cherry-picked, or used as application source.
- Future UI work must start from the latest intended source branch, then be visually compared against `ui-visual-baseline-current`.
- Use minimal, page/theme/viewport-scoped patches for UI work. Keep unrelated pages, themes, and responsive breakpoints untouched.
- Never replace whole UI files with older versions. Patch only the smallest needed selectors, components, or assets.
- Never deploy unrelated dirty files, unfinished changes, local data files, or UI work outside the requested scope.
- Before reporting `COMPLETE` for UI work, verify against real Production, not only local screenshots, mocks, or older references.

## Required UI Guard

- Run `npm run test:ui-regression` before shipping UI work.
- Set `UI_CHANGE_SCOPE` to the requested scope, for example `UI_CHANGE_SCOPE=orders`, `UI_CHANGE_SCOPE=orders,global`, or `UI_CHANGE_SCOPE=dashboard,mobile`.
- Out-of-scope UI, CSS, and public asset changes must fail and be removed or explicitly approved before deployment.
