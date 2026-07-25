# ui-visual-baseline-current

This directory is the canonical visual baseline for the current Production UI at `https://www.growuppilot.com`.

- Production deployment: `dpl_FGL4q9P1AK3aFQjcaRzZStU1HQu8`
- Baseline type: visual only, not source code
- Screenshots: 56 approved Desktop/Mobile and Light/Dark captures
- Manifest: `manifest.json`
- Referenced visual assets: `assets/`

Do not check out, restore, merge, cherry-pick, or use visual-baseline tags as application source. Future UI work must start from the latest intended source branch and be visually compared against `ui-visual-baseline-current`.

The four live application assets are recorded as verified hashes in `manifest.json` only. Their source files are intentionally not stored in this visual-baseline snapshot.

Evidence note: `scripts/report-range-summary-test.js` was introduced by commit `b7ed240179e1dcbd82162b16f1765c0bf8b14b5a` for code newer than the current Production assets, and remains unchanged for normal development.
