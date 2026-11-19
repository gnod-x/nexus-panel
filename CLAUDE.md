# Nexus Panel Project Contract

Nexus Panel is an open-source, self-hosted dashboard for organizing services and checking their availability. It replaces the presentation layer of a server landing page; it does not manage Docker containers or execute arbitrary commands.

## Architecture

- One Docker image serves the built React application and Fastify API on port 3000.
- The release bundle uses the same image and Compose file as staging; the source build override is `compose.build.yml`.
- Node.js 22, TypeScript, React, Vite, Fastify, and SQLite (`better-sqlite3`) are the supported stack.
- SQLite data lives only in `/data`; a named volume persists it. Schema changes use a versioned migration runner.
- API and browser application are same-origin. API shape and role rules are defined in `docs/api-contract.md`.
- Health checks may reach configured private service networks, but must block cloud metadata and prevent DNS rebinding and redirect-based SSRF.
- No Docker socket, SSH key, production database, real service URL, or private token belongs in the repository or staging fixtures.

## Product boundaries

- The first release includes overview, service directory, groups, search, favorites, service checks, event history, bootstrap/login, and responsive layouts.
- One local admin is created through first-run bootstrap. Operator/viewer role support is present, while user provisioning and OIDC are later work.
- The app is a single-instance dashboard. Multi-tenancy, plugins, arbitrary command execution, and cloud control-plane features are out of scope.
- Public management access must be placed behind an authenticated private network or identity-aware proxy. The app must not claim that an unconfigured public deployment is protected.

## Data and migration

- Existing Sun-Panel data is read-only input. Never modify or delete its database, uploads, configuration, or running container during development.
- Import only groups, service names, links, and descriptions. The current exporter omits icon payloads and skips unsafe links; do not import credentials, tokens, public/private access flags, or arbitrary custom JavaScript.
- The importer must preview changes and write a separate Nexus database. It must not replace an existing database.
- Cloud staging uses synthetic fixtures and has no production credentials or household addresses.

## Validation

- Run formatting/type checks, unit and API integration tests, production build, container smoke checks, and Playwright desktop/mobile flows before release.
- Keep accessibility, SSRF, authentication, backup/restore, and clean-install tests in the release gate.
- After meaningful behavior or architecture changes, update this contract and the relevant deployment/API docs from the final implementation.
