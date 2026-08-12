# Emulation Map: ECF AR (reconciliation platform) → AR Portal
Drafted 2026-08-12 from a read-only authenticated walkthrough of
https://ar-reconciliation.eastcoastfacilities.com (25 screens captured,
screenshots + DOM inventory at /tmp/ar-recon on spark).
Goal: the portal's redesign adopts THIS platform's layouts, vocabulary, and
visual language so the team's learning curve is near zero — while replacing
its two structural limits (daily CSV reconciliation, notes-instead-of-email)
with live Sage/Payee data and the comms platform.

## What the temporary platform is
Custom Laravel app on a DigitalOcean droplet (167.172.153.202, nginx).
Data is snapshot-based: footer shows "Last Reconciled: <date> 8:00 PM ET".
The daily import is the **Reconciliation screen**: CSV upload (columns
INVOICE_NUMBER, PAID_AMOUNT, PAID_DATE, NOTE) with preview → classification
(CLASSIFICATION, REASON) — i.e. payments/remittance reconciliation by hand.
Communication = threaded customer notes + @mentions with a confirm workflow
+ attachments. No outbound email.

## Design language to adopt (Phase 1 tokens)
- Warm cream surface (#f5f2eb radial to #ebe5d7), white cards, generous radius
- Geist typeface (self-host like Inter; swap tokens)
- KPI cards with colored left-border accents (blue=total, red=past due, green=current)
- Pastel SERVICE-CENTER chips used everywhere: ASC BSC BTSC CTSC FC HSC HTSC SCSC SSC TSC
- Colored "days" pills for aging (yellow→red by severity)
- Grouped top nav: Dashboard · Client Data ▾ · Operations ▾ · Insights ▾ · Help ▾ · Admin ▾ · Notifications (badge) · Sign Out
- Role + service-center scope line under every page title
- Footer freshness line (ours becomes "Live — Sage synced Xm ago" instead of "Last Reconciled")

## Vocabulary to adopt verbatim
- Collection statuses (their quick filters): Open, In Progress, HOF Support
  Required, Resubmit Requested, Resubmitted, Promised, Sent to Legal,
  Disputed, Written Off, + "Amazon View" as a dedicated lens
- "Collector" (we already say this), "Service Center" (not "location group"),
  "Watch Customer", "Stop Service", "Sales Code"
- Aging buckets: 1-30 / 31-60 / 61-90 / **91-180 / 181+** (portal currently
  ends at 91+; adopt their five buckets)

## Screen-by-screen map

| Their screen | Their key elements | Portal equivalent today | Redesign action |
|---|---|---|---|
| **Dashboard** | 5 KPI tiles (Total AR+count, Past Due+count, Current, Customers+locations, Oldest Still Open); Aging Breakdown bars; Quick Stats (sent to legal, % past due); Top 10 past-due customers w/ SC chips + day pills | Dashboard w/ KPI bar | Rebuild to their exact layout; bars + top-10 table verbatim; add live-data freshness line |
| **Invoices** (Client Data) | Quick-filter chips (status vocab above); filter bar SC/Customer/Location/Invoice#/Status/PaymentStatus/Collector/ViewMode/Sort+Direction w/ Apply/Reset; columns INVOICE NUMBER · SALES CODE · SERVICE CENTER · LOCATION · CUSTOMER · STATUS · AMOUNT · PO # · PAYMENT · AGING · COLLECTOR · MANAGE; 50/page | Invoice table w/ column filters | Adopt their column order + filter-bar layout + quick-filter chips; keep our live payee/EDI columns under "Amazon View" lens |
| **Customer detail** | Header: name + SC chips + actions (Watch, Assign collector, Stop service); KPI strip (Past Due Remaining, Total AR, Oldest, Locations); **SC breakdown cards** (per-SC past due/open/inv); Locations table (site codes! ABE5, AKC1…); Attachments; **threaded Notes**; Open Invoices table | Customer views split across dashboard filter + accounts | Build a real customer page to their layout; SC breakdown from our location data; notes panel gains threading; + our additions: Contacts, Conversations, Statement schedule |
| **My Work** | INVOICE · SALES CODE · INVOICE STATUS · DUE DATE · DAYS PAST DUE · AMOUNT · STOP SERVICE · COLLECTOR · LATEST NOTE | /my-work exists | Adopt their columns + LATEST NOTE; add comms "needs reply" strip on top |
| **Locations** | Location · Customer · Service Center · Past Due · Current · Invoices · Total AR · Collector (535 rows) | invoice_location data exists, no dedicated view | New view, their columns |
| **Service Centers** | SC-scoped rollups + SC picker in every header | regions concept | Rename/reframe regions as Service Centers portal-wide; header SC scope selector like theirs |
| **Stop Service** | CUSTOMER · SERVICE CENTERS · AGING · OLDEST PAST DUE · EFFECTIVE DATE · PREVIOUSLY STOPPED · ISSUED BY | stop-service exists (flags + list) | Adopt their list layout |
| **Watchlist** | customer-level watch | invoice-level watchlist | Add customer-level watch |
| **Reports** | AR Aging Snapshot, Invoice Detail Export | /api/reports/* richer than theirs | Keep ours, restyle to their card pattern |
| **Global Search** | one box across customers/locations/invoices | none | New: global search endpoint + screen |
| **Reconciliation** | CSV upload + preview + classification | **REPLACED**: live Sage sync makes this obsolete; keep a read-only "Payments" lens later if wanted | Deliberate non-emulation; the selling point |
| **Notifications + mentions w/ confirm** | bell w/ count; unconfirmed-mentions queue | mention bell exists | Add confirm-workflow to mentions; unify with comms action items |
| **Activity Logs / Users / Training** | audit UI, user admin, in-app training pages | activity + admin exist | Restyle; ADD a Training section (they trained the team in-app — replicate with portal-specific pages incl. comms how-tos) |

## Deliberately better (not emulated)
1. **No daily reconciliation ritual** — Sage/Omnia/Payee data is live; the
   footer says so. The Reconcile screen has no successor.
2. **Real email** — their notes about emails ("Email sent to David asking for
   payment status…") become actual conversations with the customer inside the
   same page, with reply threading, statements, dunning.
3. **Amazon depth** — their "Amazon View" filter maps to our PO Funds and
   Payee-status columns, which they have no equivalent for.

## Revised redesign phasing (supersedes generic phases in REDESIGN-PLAN.md)
1. **Tokens + shell**: their palette/typography/chips/nav-groups extracted
   into styles.css; SC scope selector in header; footer freshness line.
2. **Dashboard**: their layout, live data.
3. **Invoices**: their grid + quick filters + filter bar; collection-status
   workflow added to portal data model (invoice_collection_status table —
   the one schema addition this plan needs).
4. **Customer page**: their layout + our comms panels.
5. **My Work + Locations + Stop Service + Watchlist + Search.**
6. **Service Centers reframe + Training + Notifications unification.**

## Open questions for Edwin
- Which screens does the team live in hourly (prioritizes phases 2-5 order)?
- Collection statuses: confirm the workflow rules behind them (who sets
  "Promised" vs PTP? does "Sent to Legal" trigger anything?) so the portal
  models them as data, not just labels.
- Sunset plan: once parity ships, does the droplet platform get retired, and
  should its notes/attachments/status history migrate into the portal?
  (Laravel DB export would make that a clean one-time import.)
