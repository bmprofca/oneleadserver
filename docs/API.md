# OneLead API reference

Base URL: `/api`. All endpoints except `/auth/send-otp`, `/auth/verify-otp` and `/health` need
`Authorization: Bearer <token>`. Errors are JSON: `{ "message": "...", ...extra }`.

Roles: **admin** sees everything. **sales** only sees leads assigned to them (and reminders,
appointments and activities that belong to those leads or to them). Archived leads are hidden
unless asked for.

Paginated endpoints accept `page` and `limit` (5, 10, 20, 50, 100) and return
`{ items, total, page, limit, totalPages }`. Without `page`/`limit`, legacy endpoints return a plain array.

Datetimes are **returned** as UTC ISO strings (`2026-10-28T04:40:00.000Z`) and **accepted** as India
local time (`YYYY-MM-DD HH:mm:ss`, no offset). The frontend's `parseAppDate` handles both. Dates are `YYYY-MM-DD`.

---

## Leads — `/leads`

### Lead object
```jsonc
{
  "id": "manual_ab12…",            // string id (imported leads keep their source id)
  "name": "…", "phone": "…", "email": "…", "company": "…", "address": "…", "website": "…",
  "product_id": 1, "product_name": "CRM Suite",
  "status": "new|contacted|qualified|proposal|negotiation|won|lost|not_interested",
  "source": "manual|maps-import|import|website|referral|whatsapp|walk-in|other|…",
  "deal_value": 25000,              // number | null
  "expected_close_date": "2026-12-01", // string | null
  "lost_reason": "Price too high",  // string | null
  "assigned_to": 3, "assigned_name": "Meera",
  "whatsapp_active": 0,
  "notes": "…",
  "next_callback": "2026-10-28 11:00:00", // earliest open reminder | null
  "tags": [{ "id": 1, "name": "VIP", "color": "amber" }],
  "score": 0-100, "temperature": "hot|warm|cold|null",  // null for won/lost/not_interested
  "last_activity_at": "…", "stage_changed_at": "…",
  "archived_at": null, "merged_into": null,
  "created_at": "…", "updated_at": "…"
}
```

### Shared filters (list, stats, pipeline, export)
`search`, `status` (comma list ok), `product_id`, `assigned_to` (`id` | `unassigned` | `me`; admin only),
`source`, `tag_id`, `temperature` (`hot|warm|cold`), `callback` (`overdue|today|none`),
`created_from`, `created_to` (dates), `archived` (`only` | `all`; default hides archived).

| Method | Path | Notes |
|---|---|---|
| GET | `/leads` | Filters + `sort` = `updated` (default) `created` `oldest` `name` `score` `deal_value` `close_date` `callback` `activity` |
| GET | `/leads/stats` | `{ total, new_count, contacted_count, in_progress_count, won_count, lost_count, not_interested_count, unassigned_count, hot_count, open_value, won_value, overdue_callbacks }` (ignores `status`) |
| GET | `/leads/sources` | `[{ name, total }]` — configured + in-use sources |
| GET | `/leads/pipeline` | `probability` is a fraction (0.05 = 5%). `{ stages: [{ status, count, value, probability, weighted_value, leads: Lead[] }], totals: { open_count, open_value, weighted_value } }` — all 8 stages in order; `limit_per_stage` (10–200, default 50) |
| GET | `/leads/export?format=xlsx\|csv` | File download, same filters/sort. Audited. |
| GET | `/leads/duplicates/check?phone=&email=&exclude_id=` | `{ count, items }`. For sales, other people's matches come back as `{ name, assigned_name, status, restricted: true }` |
| GET | `/leads/duplicates` | **admin.** `{ total_groups, groups: [{ match_type: 'phone', match_value, leads: Lead[] }] }` |
| POST | `/leads/merge` | **admin.** `{ primary_id, duplicate_ids: [] }` → moves reminders/appointments/activities/history/tags to primary, fills primary's empty fields, archives duplicates (`merged_into`). Nothing is deleted. |
| POST | `/leads` | `{ name*, product_id*, phone, email, company, address, website, notes, status, source, deal_value, expected_close_date, assigned_to, tag_ids: [], whatsapp_active, force }`. Returns `{ id, assigned_to }`. **409** `{ code: 'DUPLICATE_PHONE_PRODUCT', existing }` when the mobile number already has an active lead for this product — always blocked, `force` doesn't override. **409** `{ code: 'DUPLICATE_LEAD', duplicates: [...] }` when phone/email exists under another product — resend with `force: true` to create anyway. Admin with no `assigned_to` gets round-robin assignment if enabled. |
| POST | `/leads/import` | multipart: `file*`, `product_ids*` (JSON array), `auto_assign` (bool, admin), `source`, `tag_ids` (JSON array). Returns `{ imported, duplicates, phone_duplicates, skipped, total, products, auto_assigned, links_backfilled }`. Rows whose mobile number already has a lead for that product (or appears earlier in the file) are always skipped and counted in `phone_duplicates`. |
| POST | `/leads/bulk` | `{ ids: [], action, … }` — `assign {assigned_to}` (admin), `auto_assign` (admin), `status {status, note, lost_reason}`, `archive`/`delete` (admin; archives), `restore` (admin), `whatsapp {whatsapp_active}`, `tag_add {tag_ids}`, `tag_remove {tag_ids}` |
| GET | `/leads/:id` | Lead + `counts: { open_reminders, appointments, activities }` |
| GET | `/leads/:id/timeline` | `{ items }` newest first. Each item has `kind` + `at`: `activity` (type, direction, subject, content, outcome, duration_seconds, user_name, ref_id), `status` (from_status, to_status, note, user_name), `reminder` (title, due_at, priority, is_completed, ref_id), `appointment` (title, start_at, platform, status, ref_id), `system` (action, summary) |
| GET | `/leads/:id/status-history` | Legacy |
| PUT | `/leads/:id` | Any of the create fields + `status_note`, `lost_reason`, `tag_ids` (replaces tags). `assigned_to` admin only. `product_id` can't change (400 if different). Changing `phone` to a number that has another lead for the same product → 409 `DUPLICATE_PHONE_PRODUCT`. `lost_reason` is optional on the API (bulk/legacy flows); the UI asks for one. |
| POST | `/leads/:id/restore` | **admin** — 409 `DUPLICATE_PHONE_PRODUCT` if the number is now taken for that product (bulk restore skips those and returns `skipped`) |
| DELETE | `/leads/:id` | **admin** — archives (restorable) |

## Activities — `/activities`
Types: `call`, `whatsapp`, `email`, `meeting`, `message` (SMS), `note`. Direction: `inbound|outbound`.

| Method | Path | Notes |
|---|---|---|
| GET | `/activities?lead_id=&type=&user_id=&page=&limit=` | Paginated feed; rows include `at`, `user_name`, `lead_name` |
| POST | `/activities` | `{ lead_id*, type*, direction, subject, content, outcome, duration_seconds, occurred_at }` — needs at least one of subject/content/outcome |
| PUT/DELETE | `/activities/:id` | Author or admin |

## Tasks — `/tasks`
GET `/tasks` (admin: `scope=all` or `user_id=`) →
`{ counts: { overdue, today, upcoming, completed_today, appointments_today }, overdue: Reminder[], today: Reminder[], upcoming: Reminder[] (next 7 days), completed_today: Reminder[], appointments: Appointment[] (scheduled, next 7 days) }`.
Reminder rows include `lead_name, lead_phone, lead_status, lead_whatsapp, product_name, user_name, priority`.

## Reminders — `/reminders`
Existing endpoints plus: filters `due=overdue|today|upcoming`, `priority`, `search`, `user_id` (admin), `assigned_to` (admin; lead's salesman),
`from`/`to` (`YYYY-MM-DD`, inclusive, on `remind_at`); field `priority` (`low|normal|high`), `completed_at`.
Rows include `lead_assigned_name`, `lead_whatsapp` and the lead's map fields (`lead_address`, `lead_maps_url`, `lead_business_profile_url`, `lead_latitude`, `lead_longitude`).
A reminder's `product_id` always follows its lead (any value sent is ignored).

| POST | `/reminders/:id/complete` | `{ outcome, note, type }` — completes; logs an activity if outcome/note given |
|---|---|---|
| POST | `/reminders/:id/snooze` | `{ minutes }` (1 min–30 days) or `{ until: 'YYYY-MM-DD HH:mm:ss' }` (India time, must be in the future) |

## Reports — `/reports`
GET `/reports?from=&to=&user_id=&product_id=` (default last 30 days; sales always see their own) →
```jsonc
{
  "range": { "from", "to", "days", "granularity": "day|week" },
  "summary": { "leads_created", "won", "lost", "not_interested", "win_rate" /* % or null */, "won_value",
               "avg_days_to_win", "open_leads", "open_value", "weighted_forecast", "activities_logged",
               "calls", "followups_completed", "overdue_followups" },
  "funnel": [{ "stage", "count", "conversion_from_previous" }],      // new → won, for leads created in range
  "stage_aging": [{ "status", "count", "value", "avg_days_in_stage" }],
  "trend": [{ "date", "created", "won", "lost" }],
  "activities_by_type": { "call": 3, … },
  "by_source": [{ "source", "total", "won", "won_value" }],
  "by_product": [{ "product", "total", "won", "open" }],
  "lost_reasons": [{ "reason", "total" }],
  "team": [{ "id", "name", "status", "open_leads", "open_value", "new_leads", "won", "lost", "win_rate",
             "won_value", "activities", "calls", "followups_done", "overdue" }]  // admin only, else []
}
```

## Tags — `/tags`
GET → `[{ id, name, color, lead_count }]`. POST `{ name, color }` (any user). PUT/DELETE admin.
Colors: `slate indigo blue sky teal emerald lime amber orange rose pink violet`.

## Settings — `/settings`
GET → `{ lead_sources: [], lost_reasons: [], currency, auto_assign_enabled, auto_assign_users? }`
(`auto_assign_users: [{ id, name, phone, auto_assign }]` for admin only).
PUT (admin) any of `{ auto_assign_enabled, lead_sources, lost_reasons, currency, auto_assign_users: [{ id, auto_assign }] }`.

## Audit log — `/audit` (admin)
GET `/audit?entity_type=&entity_id=&user_id=&action=&from=&to=&search=&page=&limit=` → paginated
`{ id, user_name, entity_type, entity_id, action, summary, changes: { field: [before, after] } | null, ip_address, created_at }`.
Entity types: `lead tag product user settings`. Actions include `create update assign status archive restore merge import export delete deactivate`.

## Dashboard — `/dashboard`
Existing keys plus `leads.open_leads, open_value, won_value, created_last_7_days, won_this_month`,
`reminders.due_today_reminders`, `hotLeads: Lead[]` (top 6 open by score), `recentActivity: [...]` (latest 8).

## Users / Products
Users: `auto_assign` field on create/update; list adds `open_leads`, `last_seen_at`. Deactivating a user signs them out everywhere.
Products: optional `price` (default deal value); `lead_count` excludes archived leads.
