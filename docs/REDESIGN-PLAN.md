# AR Portal UI Redesign Plan
Drafted 2026-08-12. Owner: Edwin Torres. Status: PROPOSED, awaiting go.

## Why
The portal grew feature-by-feature since June into a 5,500-line single-file app. The Comms area (2026-08) established a modern standard the rest of the portal should meet: stat tiles, pipeline visualizations, card-based layouts, live previews. The goal is one coherent, fast, genuinely modern product, without a framework rewrite and without ever destabilizing live AR operations.

## Principles
1. No framework rewrite. Vanilla JS has served well; the win is structure and design, not React.
2. Ship view-by-view behind deploy.sh gates. Every phase leaves the portal fully working; Edwin eyeballs each view before the next starts.
3. One design system, defined once. Tokens and components specified up front; every view consumes them.
4. Data first. The portal's job is scanning money tables and acting fast. Density, tabular numerals, sticky headers, and keyboard flow beat decoration.
5. Charts follow the dataviz method: pick the form by the data's job, validated palette, one axis, direct labels, hover layer, table fallback.

## Design system (Phase 1 deliverable)
- **Tokens** (`public/styles.css`, CSS custom properties): color scale (navy brand + slate neutrals + reserved status colors), type scale (Inter, 12/13/15/18/24/32), spacing (4px grid), radii (8/10/12), shadows (3 levels), z-layers.
- **Chart palette**: categorical 5-hue set validated with the dataviz validator (light + dark surface), sequential navy ramp for magnitude, diverging pair for variance views. Status colors reserved, never used as series colors.
- **Components** (documented in a `/styleguide` route, admin-only): stat tile, card, data table (sticky header, sortable, column filters, bulk-select bar), pill/chip, button set, modal, drawer, filter bar, empty states, toast notifications (replace `alert()` everywhere).
- **Architecture**: extract inline CSS from index.html into `public/styles.css`; new views load from per-area JS modules like comms.js (`dashboard.js`, `invoices.js`, `pofunds.js`); index.html shrinks toward a shell (nav + view containers + shared helpers). All static assets version-parameterized against Cloudflare edge caching.

## View-by-view (phased)

### Phase 1 — Foundation + shell (1 session)
Extract styles.css with tokens; restyle nav (active states, badge system, mobile-safe overflow); toast notification component; `/styleguide` reference page. Zero behavior change. Gate: every view visually intact, Edwin click-through.

### Phase 2 — Dashboard (1 session)
The landing experience. Hero row: total AR, past-due, DSO, collections this month (stat tiles with 30-day sparklines). Aging distribution as a proper horizontal stacked bar (validated palette, hover layer). "Needs attention" strip merging comms action items + broken PTPs + top overdue accounts. Recent activity feed. All numbers already exist in `/api/kpis` + `/api/reports/*`; this is presentation.

### Phase 3 — Invoice explorer (1-2 sessions)
The most-used screen. Sticky header + first column; saved filter views as chips (per-user, persisted); bulk-select action bar (assign collector, stop service, email — reusing comms composer); column chooser; keyboard navigation (j/k rows, Enter opens drawer); virtualized rendering for the 4k-row table (plain JS windowing, no library). Drawer becomes a right-rail with tabs: Overview / Activity (timeline) / Comms / Documents.

### Phase 4 — Customers + Reports (1 session)
Customer page becomes account-centric: header with balance + aging bar + contact strip; tabs for invoices, conversations, statements, notes. Reports rebuilt with real charts per the dataviz method (DSO trend line, collection forecast area, walk-forward, SC head-to-head as small multiples), each with table fallback and export.

### Phase 5 — PO Funds (1-2 sessions)
Densest area; highest care. Same information architecture (Ledger / Pending by Site / Needs Upload / Uploaded / Mismatches / Resubmissions / Exceptions / Off Radar), rebuilt on the shared table component with the sub-tab bar as chips, site drill-downs as expandable cards, and freshness/health strip integrated into the header. EDI transmit flows unchanged, only reskinned (transmit paths get extra manual regression care).

### Phase 6 — Dark mode + finish (1 session)
Dark theme from the same tokens (chart palette re-validated against dark surface per the dataviz method); density toggle (comfortable/compact); final a11y pass (focus order, contrast, reduced-motion).

## Guardrails
- Each phase is a normal staged deploy; git snapshots + .bak give instant rollback.
- No schema or API changes required anywhere in this plan — presentation only.
- PO Funds and EDI-adjacent screens get manual click-through with Edwin before their deploy is called done, since headless verification can't cover SSO'd interaction.
- The service worker/cache story stays as-is (version params); no new caching layers.

## Sequence and effort
Phases 1→6 in order, roughly 6-8 working sessions total. Phases 2 and 3 deliver the most visible daily-use value; if priorities force a cut, Phase 5 (PO Funds reskin) can defer indefinitely since it's functional today, and Phase 6 is polish.

## Not in scope
- Mobile-first rebuild (portal is desktop-first by usage; the shell will be responsive-safe but a dedicated mobile pass is its own decision later).
- Framework migration, build tooling, TypeScript.
- Any change to comms/dunning/statement behavior.
