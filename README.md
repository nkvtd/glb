<div align="center">
  <br />
  <img src=".github/logo_text.svg" alt="glb logo" width="360" />
  <br /><br />

  <p align="center">
    <strong>Civic data aggregator and geospatial API for Macedonia</strong>
  </p>

  <p align="center">
    Built to collect fragmented public utility notices, infrastructure outages, and environmental measurements across Macedonia and deliver structured, geo-tagged telemetry to developers and community channels.
  </p>

  <p align="center">
    <a href="https://glb.nkvtd.com/api/reports"><strong>Live API</strong></a> •
    <a href="#overview">Overview</a> •
    <a href="#key-features">Features</a> •
    <a href="#tech-stack">Tech Stack</a> •
    <a href="#data-sources--scrapers">Data Sources</a> •
    <a href="#api-reference--usage">API Reference</a> •
    <a href="#development-setup">Development</a> •
    <a href="#production-deployment">Production</a>
  </p>

  <p align="center">
    <a href="https://github.com/nkvtd/glb/actions/workflows/lint.yml"><img src="https://img.shields.io/github/actions/workflow/status/nkvtd/glb/lint.yml?style=flat-square&logo=github&label=lint" alt="Lint Status" /></a>
    <a href="https://github.com/nkvtd/glb/actions/workflows/docker.yml"><img src="https://img.shields.io/github/actions/workflow/status/nkvtd/glb/docker.yml?style=flat-square&logo=docker&logoColor=white&label=docker" alt="Docker Build" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D24.0.0-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 24.0.0" />
    <img src="https://img.shields.io/badge/typescript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 7.0" />
    <img src="https://img.shields.io/badge/hono-4.13-E36002?style=flat-square&logo=hono&logoColor=white" alt="Hono 4.13" />
    <img src="https://img.shields.io/badge/postgis-18--3.6-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL 18 + PostGIS 3.6" />
    <img src="https://img.shields.io/badge/license-Apache_2.0-blue?style=flat-square" alt="Apache-2.0 License" />
  </p>
</div>

---

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Overview](#overview)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Architecture \& Pipeline](#architecture--pipeline)
- [Data Sources \& Scrapers](#data-sources--scrapers)
- [GIS \& Spatial Engine](#gis--spatial-engine)
- [API Reference \& Usage](#api-reference--usage)
  - [Endpoints Overview](#endpoints-overview)
  - [Querying Reports (`/api/reports`)](#querying-reports-apireports)
  - [Querying Events (`/api/events`)](#querying-events-apievents)
  - [Querying Municipalities (`/api/municipalities`)](#querying-municipalities-apimunicipalities)
  - [Code Examples](#code-examples)
- [Development Setup](#development-setup)
  - [Prerequisites](#prerequisites)
  - [1. Clone \& Install](#1-clone--install)
  - [2. Configure Environment Variables](#2-configure-environment-variables)
  - [3. Build, Migrate \& Seed GIS Boundaries](#3-build-migrate--seed-gis-boundaries)
  - [4. Run in Development Mode](#4-run-in-development-mode)
  - [Available Scripts](#available-scripts)
- [Production Deployment](#production-deployment)
  - [Launching with Docker Compose](#launching-with-docker-compose)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Public infrastructure data in Macedonia—power outages, water supply defects, air quality readings, and national notices—is scattered across disconnected institutional portals, ArcGIS layers, and unformatted text feeds. Checking whether an outage in your neighborhood is planned or when service will be restored typically requires digging through multiple websites by hand.

**glb** solves this by acting as an automated civic carrier pigeon.

It operates as two strictly separated processes sharing a single PostgreSQL + PostGIS database:
1. **A Write-Only Background Worker (`src/worker.ts`)** that runs scheduled scraping strategies, normalizes raw upstream payloads into clean Macedonian prose, resolves locations against official municipal boundaries, reconciles event lifecycles, and dispatches real-time alerts to Discord.
2. **A Read-Only HTTP Server (`src/server.ts`)** powered by **Hono** that serves validated, cursor-paginated, and spatially indexed data at **[https://glb.nkvtd.com/api](https://glb.nkvtd.com/api/reports)**.

---

## Key Features

- **Strategy-Driven Scraping Engine:** Each upstream provider is encapsulated in a strongly typed `ScrapingStrategy` validated at runtime with **Zod** and scheduled via **Croner**.
- **Hybrid PostGIS Spatial Resolution:** Maps both exact WGS 84 coordinates (`ST_Covers`) and raw Macedonian/English settlement strings (`MunicipalityResolver`) to official administrative `PCODEX` identifiers.
- **Automated Lifecycle Reconciliation:** A 15-minute background reconciler automatically transitions records between `scheduled`, `ongoing`, `ended`, `omitted`, and `unknown` states—handling open-ended superseding and stale upstream feeds without manual intervention.
- **Single-Alert Relay (`glb::relay`):** Pushes color-coded embeds to Webhook channels (Discord, etc) in rate-limited batches when incidents become `ongoing`, tracking active locations so consecutive hourly updates never spam the channel.
- **Keyset Cursor Pagination:** Deterministic tuple-based cursor pagination (`(sortExpr, id)`) across all collection endpoints with zero offset performance degradation.
- **Hardened Read-Only API:** Built-in IP rate limiting (`60 req/min` aware of Cloudflare Tunnel headers), strict request/response DTO validation, security headers, and structured **Winston** rotating logs.

---

## Tech Stack

| Category | Technology | Role in `glb` |
| :--- | :--- | :--- |
| **Runtime & Language** | Node.js `>=24.0.0`, TypeScript `7.0` | Native ESM execution, `fetch` with `AbortSignal`, and strict compiler checks (`NodeNext`). |
| **HTTP Framework** | Hono `4.x`, `@hono/node-server` | Read-only REST API routing, security headers, CORS, request ID correlation, and IP rate limiting (`hono-rate-limiter`). |
| **Database & GIS** | PostgreSQL `18`, PostGIS `3.6` | Relational storage with GiST-indexed `geometry(Point, 4326)` and `geometry(MultiPolygon, 4326)` columns. |
| **ORM & Migrations** | Drizzle ORM, Drizzle Kit, `drizzle-zod` | Type-safe SQL queries, schema-driven DTO projection, and automated SQL migration generation. |
| **Validation** | Zod `4.x`, `zod-validation-error` | Runtime validation for environment config, upstream scraper payloads, HTTP query parameters, and response DTOs. |
| **Scheduling** | Croner `10.x` | In-process cron scheduling with overlap protection (`protect: true`) for scrapers and the 15-minute lifecycle reconciler. |
| **Logging** | Winston, `winston-daily-rotate-file` | Structured JSON file logs (7-day retention for combined, error, exception, and rejection streams) and formatted console output. |
| **Build & Quality** | Esbuild, Biome `2.5` | Fast ESM bundling to `dist/` and unified linting, formatting, and import sorting. |
| **Deployment** | Docker Buildx, GitHub Actions, Watchtower | Multi-arch (`linux/amd64`, `linux/arm64`) images published to GHCR and rolled out automatically in production. |

---

## Architecture & Pipeline

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                      Upstream Civic Data Sources                          │
│        EVN (Power)   •   Vodovod Skopje (Water)   •   MOEPP (Air)         │
└───────────────────────────────────────────────────────────────────────────┘
                                   │  Scheduled Cron Jobs (*/30 * * * *)
                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Background Worker (src/worker.ts)                                        │
│  • Zod Upstream Validation & Macedonian Prose Formatting                  │
│  • MunicipalityResolver (PostGIS ST_Covers + Text Cascade)                │
│  • Transactional Upsert, Deduplication & 15-min Lifecycle Reconciler      │
│  • AlertDispatcher -> Webhook Channel (glb::relay)                        │
└───────────────────────────────────────────────────────────────────────────┘
                                   │  Drizzle ORM (node-postgres)
                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  PostgreSQL 18 + PostGIS 3.6                                              │
│  • Tables: municipalities, reports (spatial), events (national)           │
│  • GiST Spatial Indexes (SRID 4326) & Composite B-Tree Indexes            │
└───────────────────────────────────────────────────────────────────────────┘
                                   │  Read-Only Queries & DTO Mapping
                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Hono REST API Server (src/server.ts)                                	  	│
│  • Rate Limiting, CORS, Secure Headers & Request ID Correlation      	  	│
│  • Endpoints: /api/reports, /api/events, /api/municipalities         	    │
│  • Live Instance: [https://glb.nkvtd.com/api](https://glb.nkvtd.com/api)	│
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Data Sources & Scrapers

The worker currently runs three active scraping strategies depending on their cron schedule, alongside the 15-minute status reconciler:

| Source ID | Category | Target | Schedule | Upstream Provider | Resolution & Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `evn` | `power` | `reports` | `*/30 * * * *` | **EVN Elektrodistribucija** | Hashes distribution center, interruption type, place, address, timeframe, and voltage level into a deterministic 32-character SHA-256 `externalId`. Formats affected streets into natural Macedonian prose and resolves municipalities via text cascade. |
| `vodovod-skopje` | `water` | `reports` | `*/30 * * * *` | **JP Vodovod i Kanalizacija – Skopje** | Queries the ArcGIS MapServer for active and recent water/sewage interventions. Extracts `POINT(lng lat)` geometries, formats urgency and street details into prose, and resolves municipalities via text cascade with a PostGIS point-in-polygon fallback. |
| `moepp` | `air_quality` | `reports` | `*/30 * * * *` | **Ministry of Environment (MOEPP)** | Fetches monitoring stations and hourly pollutant concentrations (`PM10`, `PM2.5`, `NO₂`, `O₃`, `SO₂`, `CO`). Resolves municipalities via PostGIS point-in-polygon (`ST_Covers`) with text fallback. Marks poor air quality (`index 04–06`) as `ongoing` (triggering a single alert per smog episode) and normal readings as `omitted` (stored for API querying without alert spam). |

> **Supported Schema Categories & Statuses:**
> - **Localized Reports (`reports`):** `power`, `water`, `road`, `weather`, `wildfire`, `air_quality`
> - **National Events (`events`):** `fuel_price`, `currency_exchange`
> - **Lifecycle Statuses:** `scheduled`, `ongoing`, `ended`, `unknown`, `omitted`

---

## GIS & Spatial Engine

Administrative boundaries and municipal metadata are seeded from the Humanitarian Data Exchange (HDX) Common Operational Datasets for Macedonia:

> **GIS Dataset Source:** [HDX — Macedonia Administrative Boundaries (Admin Level 0–2)](https://data.humdata.org/dataset/cod-ab-mkd/resource/9ac00088-e0d1-47b0-a4cd-06500776e93b) (`data/mkd_admbnda_adm2_2025_AB.geojson`)

- **Municipal Polygons & Centroids:** Each feature in the GeoJSON collection is stored in `municipalities` with its `PCODEX` (`code`), `ADM2_PCODE` (`municipalityCode`), `ADM1_PCODE` (`regionCode`), Macedonian and English names, `urban`/`rural` morphological type, `MultiPolygon` boundary (`SRID 4326`), and a surface-guaranteed centroid computed via `ST_PointOnSurface`.
- **Hybrid Proximity Search:** When querying `/api/reports` with `lat`, `lng`, and `radius`, PostGIS returns both exact point reports within the radius (`ST_DWithin` on `reports.geom`) **and** municipality-wide reports (where `geom IS NULL`) whose municipal boundary intersects the search radius.

---

## API Reference & Usage

The live production deployment is publicly available at:

> **Base URL:** `https://glb.nkvtd.com/api`

All endpoints are read-only (`GET`), CORS-enabled, and rate-limited to **60 requests per minute per IP**. Internal scraping metadata (`rawPayload`, `scrapedAt`, `updatedAt`, and raw EWKB geometry columns) is automatically stripped and transformed into clean DTOs.

### Endpoints Overview

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/ping` | Liveness check returning `{ "message": "pong" }`. |
| `GET` | `/api/ready` | Readiness check verifying PostgreSQL connectivity (`SELECT 1`). |
| `GET` | `/api/reports` | Cursor-paginated list of localized civic reports with text, date, category, and spatial proximity filters. |
| `GET` | `/api/reports/:id` | Fetch a single localized report by its numeric ID. |
| `GET` | `/api/events` | Cursor-paginated list of national/non-spatial events. |
| `GET` | `/api/events/:id` | Fetch a single national event by its numeric ID. |
| `GET` | `/api/municipalities` | Cursor-paginated list of Macedonia municipalities with optional GeoJSON boundary polygons and point-in-polygon lookup. |
| `GET` | `/api/municipalities/:code` | Fetch a single municipality by its `PCODEX` code (includes `MultiPolygon` boundary by default). |

---

### Querying Reports (`/api/reports`)

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `cursor` | `string` | — | Base64URL keyset pagination cursor from `meta.nextCursor`. |
| `pageSize` | `number` | `20` | Items per page (`1`–`100`). |
| `sortBy` | `string` | `startsAt` | Sort column: `id`, `observedAt`, `startsAt`, or `endsAt`. |
| `sortDirection` | `string` | `desc` | Sort direction: `asc` or `desc`. |
| `status` | `string` | — | Comma-separated statuses: `scheduled`, `ongoing`, `ended`, `unknown`, `omitted`. |
| `category` | `string` | — | Comma-separated categories: `power`, `water`, `road`, `weather`, `wildfire`, `air_quality`. |
| `source` | `string` | — | Upstream scraper source identifier (e.g., `evn`, `vodovod-skopje`, `moepp`). |
| `municipalityCode` | `string` | — | Filter by official `PCODEX` code (e.g., `MK0080903`). |
| `search` | `string` | — | Case-insensitive substring search (`1`–`100` chars) across `title`, `description`, and `locationLabel`. |
| `from` | `Date / ISO` | — | Lower bound timestamp matched against `COALESCE(startsAt, observedAt)`. |
| `to` | `Date / ISO` | — | Upper bound timestamp matched against `COALESCE(startsAt, observedAt)`. |
| `lat` | `number` | — | Latitude (`-90` to `90`). Must be provided together with `lng`. |
| `lng` | `number` | — | Longitude (`-180` to `180`). Must be provided together with `lat`. |
| `radius` | `number` | `5000` | Search radius in meters (`50`–`50000`) around `lat`/`lng`. |

---

### Querying Events (`/api/events`)

Supports `cursor`, `pageSize` (default `20`), `sortBy` (`id`, `observedAt`, `startsAt`, `endsAt`), `sortDirection` (`asc`, `desc`), `status` (comma-separated), `category` (comma-separated: `fuel_price`, `currency_exchange`), `source`, `search` (`title`, `description`), `from`, and `to`.

---

### Querying Municipalities (`/api/municipalities`)

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `cursor` | `string` | — | Base64URL keyset pagination cursor. |
| `pageSize` | `number` | `100` | Items per page (`1`–`100`). |
| `sortBy` | `string` | `nameMk` | Sort column: `id`, `code`, `nameMk`, or `nameEn`. |
| `sortDirection` | `string` | `asc` | Sort direction: `asc` or `desc`. |
| `regionCode` | `string` | — | Filter by `ADM1_PCODE` region code (e.g., `MK008`). |
| `municipalityCode` | `string` | — | Filter by `ADM2_PCODE` code (e.g., `MK00809`). |
| `morphologicalType` | `string` | — | Filter by `urban` or `rural`. |
| `search` | `string` | — | Case-insensitive search across Macedonian/English municipality & region names and `code`. |
| `lat` & `lng` | `number` | — | Point-in-polygon lookup (`ST_Covers`) returning the municipality containing those coordinates. |
| `includeBoundary` | `boolean` | `false` | Set to `true` to include the full GeoJSON `MultiPolygon` `boundary` in each item (`true` by default on `/api/municipalities/:code`). |

---

### Code Examples

**1. Fetch ongoing power, water, and air quality reports:**
```bash
curl -s "https://glb.nkvtd.com/api/reports?category=power,water,air_quality&status=ongoing&pageSize=5" | jq
```

**2. Spatial radius search (reports within 3 km of central Skopje):**
```bash
curl -s "https://glb.nkvtd.com/api/reports?lat=41.9981&lng=21.4254&radius=3000" | jq
```

**3. Reverse-geocode coordinates to a Macedonia municipality:**
```bash
curl -s "https://glb.nkvtd.com/api/municipalities?lat=41.9981&lng=21.4254&includeBoundary=false" | jq
```

**4. Paginating reports in TypeScript / JavaScript:**
```typescript
const baseUrl = 'https://glb.nkvtd.com/api/reports';

async function fetchActiveReports() {
    const params = new URLSearchParams({
        status: 'ongoing,scheduled',
        category: 'power,water,air_quality',
        pageSize: '20',
        sortBy: 'startsAt',
        sortDirection: 'desc',
    });

    const res = await fetch(`${baseUrl}?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const { data, meta } = await res.json();
    console.log(`Fetched ${data.length} reports. Next cursor:`, meta.nextCursor);
}
```

**Example `/api/reports` Response Payload:**
```json
{
  "data": [
    {
      "id": 42,
      "externalId": "8f3c2a91d4e6b70192a3c4d5e6f70819",
      "source": "evn",
      "category": "power",
      "title": "Планирани прекини: Аеродром, Скопје",
      "description": "Без електрична енергија ќе останат корисниците во: бул. Јане Сандански.",
      "municipalityCode": "MK0080901",
      "locationLabel": "Аеродром, Скопје",
      "status": "ongoing",
      "observedAt": "2026-10-22T17:30:00.000Z",
      "startsAt": "2026-10-22T07:00:00.000Z",
      "endsAt": "2026-10-22T13:00:00.000Z",
      "coordinates": null
    }
  ],
  "meta": {
    "nextCursor": "eyJ2IjoiMjAyNi0xMC0yMlQwNzowMDowMC4wMDBaIiwiaWQiOjQyfQ",
    "hasNextPage": true
  }
}
```

---

## Development Setup

### Prerequisites
- **Node.js** `>= 24.0.0`
- **PostgreSQL** with the **PostGIS** extension (or Docker)

### 1. Clone & Install

```bash
git clone https://github.com/nkvtd/glb.git
cd glb
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and configure your environment:

```bash
cp .env.example .env
```

`src/core/config.ts` validates the following variables at startup:

```ini
# HTTP Server Port (optional, defaults to 8080)
PORT=8080

# PostgreSQL + PostGIS Connection URL (required)
DATABASE_URL=postgresql://postgres:password@localhost:5432/glb-db

# Discord Webhook URL for real-time alerts (optional)
DISCORD_WEBHOOK_URL=[https://discord.com/api/webhooks/](https://discord.com/api/webhooks/)...
```

### 3. Build, Migrate & Seed GIS Boundaries

Apply the Drizzle SQL migrations (which enable the `postgis` extension and create all tables/indexes) and seed the Macedonia municipal boundaries from `data/mkd_admbnda_adm2_2025_AB.geojson`:

```bash
# Run Drizzle migrations
npm run db:migrate

# Seed Macedonia municipalities into PostGIS
npm run db:seed
```

### 4. Run in Development Mode

Run the Hono server and the background worker in separate terminals using `tsx`:

```bash
# Terminal 1 — Start the Hono API server on http://localhost:8080/api
npm run dev:server

# Terminal 2 — Start the scraping orchestrator & reconciler worker
npm run dev:worker
```

### Available Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm run dev:server` | `tsx src/server.ts` | Run the HTTP API server directly from TypeScript source. |
| `npm run dev:worker` | `tsx src/worker.ts` | Run the background scraper worker directly from source. |
| `npm run build` | `rimraf dist && node esbuild.config.js` | Bundle and minify `src/**/*.ts` into `dist/` via Esbuild. |
| `npm run start:server` | `node dist/server.js` | Run the compiled production HTTP server. |
| `npm run start:worker` | `node dist/worker.js` | Run the compiled production background worker. |
| `npm run db:generate` | `drizzle-kit generate` | Generate new SQL migration files from `src/core/schema.ts`. |
| `npm run db:migrate` | `drizzle-kit migrate` | Apply pending SQL migrations to the database. |
| `npm run db:seed` | `node dist/infrastructure/database/seed.js` | Seed `data/mkd_admbnda_adm2_2025_AB.geojson` into `municipalities`. |
| `npm run lint` | `biome check src` | Run Biome linter and formatter checks. |
| `npm run lint:fix` | `biome check --write src` | Automatically fix lint and formatting issues with Biome. |
| `npm run format` | `biome format --write src` | Format `src/` using Biome (`4` spaces, single quotes). |

---

## Production Deployment

In production, **glb** is packaged into a multi-architecture (`linux/amd64`, `linux/arm64`) Docker image published to `ghcr.io/nkvtd/glb:latest` and orchestrated via `docker-compose.yml`.

The production stack consists of four services:
1. **`postgres` (`postgis/postgis:18-3.6`):** Spatial database using Docker secrets for password management.
2. **`migrate` (`ghcr.io/nkvtd/glb:latest`):** One-shot initialization container that waits for `postgres` to become healthy, constructs `DATABASE_URL` from the Docker secret, and runs `npm run db:migrate` and `npm run db:seed`.
3. **`server` (`ghcr.io/nkvtd/glb:latest`):** Runs `npm run start:server` once `migrate` completes, exposing port `8080` with a built-in `/api/ready` healthcheck and Watchtower auto-update labels.
4. **`worker` (`ghcr.io/nkvtd/glb:latest`):** Runs `npm run start:worker` in the background once `migrate` completes, also managed by Watchtower.

### Launching with Docker Compose

1. Create the database password secret file from the example template:
   ```bash
   cp secrets/database_password.example.txt secrets/database_password.txt
   # Edit secrets/database_password.txt with your strong database password
   ```

2. Ensure the external proxy network exists (if routing via an edge proxy or tunnel):
   ```bash
   docker network create edge-proxy
   ```

3. Configure your `.env` file (e.g., `DISCORD_WEBHOOK_URL`, `POSTGRES_USER`, `POSTGRES_DB`) and start the stack:
   ```bash
   docker compose pull
   docker compose up -d
   ```

---

## Project Structure

```text
glb/
├── data/
│   └── mkd_admbnda_adm2_2025_AB.geojson # Official HDX Macedonia Admin Level 2 boundaries
├── secrets/
│   └── database_password.example.txt    # Template for Docker Compose DB secret
├── src/
│   ├── core/
│   │   ├── config.ts                    # Zod-validated environment configuration
│   │   ├── enums.ts                     # Report and event category definitions
│   │   ├── schema.ts                    # Drizzle ORM tables, PostGIS types & enums
│   │   ├── types/                       # Typed rawPayloads (evn, moepp, vodovod-skopje)
│   │   └── validation/                  # Upstream response Zod schemas
│   ├── infrastructure/
│   │   ├── alerting/                    # AlertChannel interface, Dispatcher & DiscordChannel
│   │   ├── database/                    # pg Pool, Drizzle instance, migrations & GIS seeder
│   │   └── logging/                     # Winston console + daily rotating file logger
│   ├── modules/
│   │   ├── api/                         # Hono app, routes, Drizzle queries & DTO validators
│   │   └── scraping/                    # ScrapingOrchestrator, MunicipalityResolver & Strategies
│   ├── server.ts                        # Read-only HTTP API entrypoint
│   └── worker.ts                        # Write-only background scraper entrypoint
├── Dockerfile                           # Multi-stage Node 24 Alpine build
├── biome.json                           # Biome linter & formatter configuration
├── docker-compose.yml                   # Production multi-container orchestration
├── drizzle.config.ts                    # Drizzle Kit configuration
├── esbuild.config.js                    # Esbuild ESM bundler configuration
├── package.json
└── tsconfig.json
```

---

## Contributing

Contributions, new utility scraping strategies, and geospatial improvements are welcome:

1. Fork the repository and create a feature branch.
2. Follow the existing module conventions (use explicit `.js` extensions on relative imports for `NodeNext` ESM resolution).
3. Run `npm run lint` and `npx tsc --noEmit` to verify your changes pass **Biome** and strict TypeScript checks.
4. Submit a Pull Request.

---

## License

Licensed under the **Apache License 2.0**.