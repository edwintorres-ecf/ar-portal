# ECF Command Environment — Master Blueprint (Q3 2026)
# Authored by research agent 2026-07-20; approved charter pending Edwin sign-off.
# The Finance pilot (Phases 1-3) is the template; this generalizes it estate-wide.

## 1. Domain ground-truth inventory
- Finance/Hermes: AR portal (ar-portal.db, exceptions/overages/resubmissions APIs, ops stack) — generator READY (designed).
- HR/Juno: RICH — recruit.db on spark: candidates pipeline (210 new, 162 in_progress, 100 phone_interview, 33 ready_for_skills_test, 413 unresponsive), qdp_samsara_queue, adp_hire_queue (EMPTY — confirm semantics w/ Edwin), campaign_spend, /api/dashboard/overdue, /api/kpi. ADP deliberately manual: Juno prepares field-by-field action briefs; Edwin logs in himself.
- Systems/Bayamanaco: Guardian LaunchDaemon (guard.log, expected-changes.json), launchd fleet, backup jobs (SharePoint backups BROKEN — disabled jobs + 2 ad-hoc fix crons), backup_runs table, gateway watchdog. MEMORY.md months stale — fix via approved amendment.
- FieldOps/Guabancex: Sentinel IS a queue already — alerts.json + audit-log.jsonl, 44 snow-comms Slack channels (read-only to agents), PO notifications, arclerk email agent.
- Legal/Ares: NO structured sources. Prose matters in MEMORY.md + compliance//legal/ docs. One derived hook: Amazon dispute aging from AR portal. → inbox-intake + derived generators only.
- Marohu/Boinayel/Sage/Specter/Dispatch: inbox-only until sources exist. Dispatch staff-request routing = strongest future 6th generator.
- 78 of 117 cron jobs run under main incl. per-domain digests — reporting already centralized de facto.

## 2. Architecture — EDWIN OVERRIDE 2026-07-20: standalone Edwin-only Command service
Edwin: "The AR portal is something forward facing. This needs to be internal, as something that only I see and only I have access to." The AR portal serves the whole AR team (admin/manager/ar_specialist/viewer) — the queue CANNOT live there.
Revised: /home/ecf-admin/command on spark, own command.db, own Express process bound to tailnet/localhost ONLY (no cloudflared route, no public DNS). Human auth: SSO pinned to edwin.torres@eastcoastfacilities.com exclusively. Agent auth: scoped bearer tokens, tailnet-only, unchanged. The AR portal becomes a read-only DATA SOURCE (like recruit.db) and the EXECUTION TARGET for approved finance actions (approved work commits through ar-portal APIs; staff see effects, never the queue). Reliability stack (ops-alerts, deploy gating, self-test, invariants) extracted as shared modules used by both services. Everything below about schema, tokens, adapters, brief, guardrails, and phases is unchanged except: host = command service, not ar-portal.

## [superseded by override above] 2. Original: Command Queue stays in ar-portal
Extend ar-portal.db + agent-api.js. No standalone service (would duplicate the only hardened reliability stack: ops-alerts, deploy.sh, self-test, audit, tailnet+bearer). SQLite single-writer = collision-proof claims. Never on a real-time critical path; portal restart degrades to stale brief. Escape hatch: agent_-prefixed tables reachable only via agent-api.js → clean lift-out later.
Schema additions to Phase-1: agent_tasks.domain (finance|hr|systems|fieldops|legal|inbox-*), priority_score, filed_by.
Generator adapters per domain: queue-generator.js (finance, in-process); recruit-generator.js (spark, sqlite3 -readonly on recruit.db → POST /api/agent/tasks/ingest); iMac adapters for Sentinel + Systems posting over tailnet. Per-source source_generation (one stale domain never stales another). Adapter silence > 2× period = red + ops-alert.
Inbox intake: POST /api/agent/tasks/file — any agent files conversationally; first-class lifecycle.
Token scopes: AGENT_API_TOKENS="hermes:<hex>:finance,legal-derived; juno:<hex>:hr; bayamanaco:<hex>:systems; guabancex:<hex>:fieldops; atlas:<hex>:inbox-*" — claim filters by domain server-side (WHERE clause, not prompt rule). agent_domain_policy table: finance edwin, hr edwin, systems edwin (diagnostics none), fieldops edwin, legal edwin_2step ALWAYS.

## 3. Unified morning brief
One WhatsApp message 7:45 ET weekdays (Discord mirror best-effort). NEVER-list compliant: plain numbered lines, no markdown tables, no em dashes, no filler openers. Per-domain status line + ONE cross-domain NEEDS YOU list, hard cap 5, one overflow line per unrepresented domain.
Priority function (deterministic, queue-computed; model never ranks):
score = base(type,10..40) + 10*log10(max(amount,100)/100) + (deadline<48h:+30 | <7d:+15) + (human-blocked:+20) + age(+1/day past 3d); safety/legal-deadline classes floor at 70; held items resurface +10 after 3d.
Grammar: approve 1,3 · reject 2 <reason> · hold 4 · confirm N (2-step). Item maps persist per day; executions confirm with verification evidence.

## 4. Guardrails (extends Finance matrix)
- HR: prepare ADP briefs/QDP packets (no approval, inert; recruit.db state verified). Contact candidates: NOBODY v1. ADEA/termination: edwin_2step + auto-filed Ares cross-check task; archive-only (EEOC). PII structurally stripped from briefs.
- Legal: drafts edwin_2step to mark done; SEND EXTERNAL: NOBODY EVER (Edwin out-of-band only).
- Systems: diagnostics read-only no approval (cite raw output); remediation = exact command product, edwin per action, post-run verify, Guardian expected-changes + checkpoint first; Guardian/Sentinel source changes deploy-gate only.
- FieldOps: monitor/summarize/draft (drafts need edwin); dispatch crews / post to snow-comms / contact Amazon FC: NOBODY v1.
- Sage/Intacct writes: NOBODY (unchanged).

## 5. NEVER-SUGGEST-AGAIN constraints honored
No filler openers; no em dashes; no markdown tables in chat surfaces; never delete — archive first (ratifies rejecting curator auto-archival); nothing external without approval — draft only (Ares stricter: never); Guanín no live trading until >40% win over 30+ paper cycles.

## 6. Program plan (24-30 build days, each phase independently shippable)
- Wk 1-4  Finance Phases 1-3 as designed (reassignment, transmission-exception, resubmission-ready).
- Wk 5    Systems adapter (3-4d): backup-stale-or-failed; service-degradation; pending-system-updates. Converts SharePoint-backup saga into real tasks.
- Wk 6-7  HR recruit-generator (4-5d): pipeline-stall; qdp-ready; adp-hire-prep (confirm adp_hire_queue semantics first; fallback status=hired).
- Wk 8    FieldOps Sentinel adapter (3-4d, BEFORE snow season): unacknowledged-site-alert; site-pattern-anomaly; amazon-fc-escalation-draft.
- Wk 9    Legal (2-3d): inbox + dispute-aging (portal-derived) + compliance-calendar.json (ADEA windows, retention, renewals).
- Consolidation milestone (end wk 8): retire per-domain digests (Guabancex Nightly, Bayamanaco Nightly + Weekly Update Check, Ares Weekly + compliance-check) on top of 8 finance-era retirements → ONE brief + Sunday Ops Review (queue throughput, approval latency, rejection causes, verified-green across 5 domains).
- Personal agents (Guanín, Titan): EXCLUDED entirely — no shared surface, tokens, or data. Revisit next quarter only if Edwin asks.

## Honest unknowns
adp_hire_queue empty — confirm semantics; employee-side credential expirations (current staff CDL/medical) exist nowhere machine-readable — inbox gap until ADP export; Bayamanaco MEMORY.md stale; Dispatch routing not yet inventoried.
