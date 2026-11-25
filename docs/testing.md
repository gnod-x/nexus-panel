# Testing and release evidence

Use Node.js 22 and `package-lock.json`. Run tests against disposable synthetic fixtures. A source build, a running process, HTTP reachability and authenticated end-to-end behavior are separate checks.

## Static, unit/API and Python checks

```bash
npm ci
npm run check
python3 -B -m unittest discover -s tests -p 'test*.py' -v
python3 -B -m unittest discover -s tests/server -p 'test*.py' -v
npm audit --omit=dev --audit-level=high
```

`npm run check` combines type checking, Vitest and production build; it does not run Python, browsers or containers. Both Python discovery roots are required. Permission tests must run as an ordinary user. Python `-B` avoids disposable bytecode caches.

The 0.2.0 candidate passed 338 Vitest tests, 19 root Python methods, 24 server Python methods, type checking and production build. Production npm audit reported zero known vulnerabilities in that run; this is a point-in-time result.

## Chromium baseline

```bash
npx playwright install --with-deps chromium
E2E_ARTIFACT_ROOT=artifacts/local-release-20261125/baseline/final \
  npx playwright test --config playwright.config.ts
```

The baseline owns loopback 4173, rebuilds the source, starts a memory-database server and excludes `audit-ui.spec.ts`. `PLAYWRIGHT_CHROMIUM_PATH` can select an installed compatible browser; otherwise Playwright's managed Chromium is used. One worker avoids shared fixture races.

## Independent Chromium and Firefox audit

```bash
npx playwright install --with-deps chromium firefox
chromium_path=$(node -e 'console.log(require("@playwright/test").chromium.executablePath())')
E2E_ARTIFACT_ROOT=artifacts/local-release-20261125/audit/final \
  PLAYWRIGHT_CHROMIUM_PATH="$chromium_path" \
  npx playwright test --config playwright.audit-ui.config.ts
E2E_ARTIFACT_ROOT=artifacts/local-release-20261125/audit/final \
  AUDIT_BROWSER=firefox AUDIT_REUSE_BUILD=true \
  npx playwright test --config playwright.audit-ui.config.ts
```

The audit owns loopback 4274 and a separate memory-database server. Its build path resolves from the current checkout. Run engines sequentially. Reuse is valid only when the existing audit build matches the exact source under test; source changes require rebuilding. Artifact roots should be checkout-relative and identify each run. Separate suites use independent ports/paths but still require sufficient CPU/memory.

Coverage includes role boundaries, real isolated CRUD/import rollback, session/request ordering, failures versus empty data, task freshness, management routes, native dialogs/drawers, keyboard/focus, reduced motion, both themes, 320px layouts, enlarged text, long uninterrupted names and bounded capacity fixtures. The audit also runs homepage schedule/font cases. Chromium does not substitute for Firefox.

## Image, recovery and deployment checks

```bash
docker build --build-arg APP_VERSION=0.2.0 -t nexus-panel:0.2.0 .
LOGIN_USERNAME= LOGIN_USER_ID= bash scripts/compose-smoke.sh nexus-panel:0.2.0
bash scripts/package-release.sh release
```

The smoke script creates disposable Compose projects/volumes and synthetic credentials. It covers anonymous protection, first-admin bootstrap/login, directory/health checks, default/changed fonts, restart persistence, whole-volume backup/new-volume restore, unconfigured boundaries and explicit demo mode. Its `down -v` cleanup applies only to temporary projects. Packaging unit tests use a synthetic Docker CLI; also inspect the real image/bundle and checksum.

For an installed service, compare effective Compose configurations, preserving project/volume/mounts, private allowlist and resource/security limits. Take a stopped-volume private backup. Verify Docker health, version 0.2.0, current HTML/JS/CSS/font hashes and anonymous 401 responses, then authenticated read-only directory/task/integration/settings behavior. Compare integrity, schema and table counts/content digests against the stopped pre-upgrade state. Temporary maintenance sessions must be removed in `finally`; their use does not claim that a user's password-based browser login was tested.

## Release diagnostic history

Historical cloud font-specific tests passed, but broad cloud suites had stale heading/task-navigation assertions. They were not accepted as full-release evidence. Local tests now use the current hidden 工作台 heading, embedded homepage task section and separate management routes while retaining behavior coverage.

The first local baseline recorded 53/57 passed; failures exposed a genuine 320px long-name task-card overflow and obsolete light-default theme expectations. The first audit recorded 71/74 passed: that overflow/theme issue and a composite CRUD test reaching its total deadline while sharing constrained browser resources. The flex child's minimum content width caused the overflow; a local `min-width: 0` and `overflow-wrap: anywhere` repair passed independent probes in both themes at 320/375/844/1440px and doubled text at 320px. Initial failures remain diagnostic evidence. Final acceptance uses fresh builds/reruns after the repairs, without skipped tests or weakened overflow assertions.

## Evidence scope and retention

Retain JSON reports, logs, relevant screenshots/traces, image identities and required private rollback materials. Keep household data/configuration out of source control and release assets. Remove this task's temporary browsers/dependencies, isolated containers/volumes and superseded build outputs after verification; never prune another task's resources.

Fixture or short-run success does not prove long-term capacity, complete task coverage, external-job execution, universal credential DLP, visitor-device fonts or real remote-client acceptance. Read-only integration connectivity does not prove that upstream data just changed.
