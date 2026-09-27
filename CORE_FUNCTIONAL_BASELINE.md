# Growup Pilot Core Functional Baseline

Reference implementation: `ea6dd2307d3892412d9f9a17107b537a180fede7`.

This baseline protects two Production-critical behaviors without changing the
Golden UI baseline:

1. Complete tenant Orders retrieval: Supabase/API reads must return every
   tenant order, including datasets larger than 1,000 rows, exactly once.
2. Confirmed Delete Order: an authorized delete must complete its full audited
   lifecycle, including when the session/JWT refreshes between intent creation
   and confirmation.

Run the mandatory gate with:

```sh
npm run test:core-functional-baseline
```

The gate runs the Orders pagination regression, the full local HTTP Delete Order
lifecycle regression, database delete-guard checks, and destructive-path
hardening checks. The fixtures are local/test-only; they do not use or mutate
Production customer orders.

`npm run predeploy` always executes this gate after the UI regression and
Golden UI safety gates. A non-zero result is a release blocker: do not deploy.
`npm test` also retains both functional regressions as part of the full test
suite.

Golden UI protection remains separate and unchanged: backend functional
behavior is not a visual baseline, and `npm run test:golden-ui` remains the
authoritative Golden UI guard.
