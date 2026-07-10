# CLAUDE.md — operating notes for this repo

This automation reads Linear tickets (synced from BugHerd), diagnoses intent with AI, and edits
live Webflow CMS/static content. It has caused real production corruption more than once. Every
rule below traces to a confirmed live incident or a confirmed capability test — not theory. Read
this before running any real (non-dry-run) batch, and update it when you learn something new the
hard way.

## Operating posture

- **Correctness over speed or cost.** AI usage cost is a non-issue; it is never a reason to skip
  or downgrade the `diagnoseRequest` safety gate.
- **Confidence without overconfidence.** Keep pushing on ambiguous-but-plausibly-automatable
  cases, but the moment a pattern shows real risk of a wrong write, stop and skip rather than
  force it through — a correctly-skipped ticket is not a failure, it's the pipeline working.
- **Batch by relationship, not ticket-by-ticket.** When picking up a ticket, check its
  parent/sub-issues/similar-titled siblings first and process the group together with full
  conflict context (`discoverBatches`' grouping logic).
- **Always preserve old + new values in the ticket comment** on every applied edit — never a
  diff-less overwrite.
- Tickets correctly diagnosed as non-automatable (structural/ambiguous/new_item/not_visual/
  scope-mismatch/no-Link-field-found) are not "remaining backlog to clear" — they're correct
  exclusions requiring human review, not something to route around.
- **Autonomous/scheduled polling is authorized** (as of 2026-07-10), on two tiers: GitHub Actions
  cron for the REST-only capability tier, and a `CronCreate`-scheduled interactive Claude Code
  session for the MCP-connector-dependent tier (component/image/link edits beyond what the REST
  pipeline can do — see below). The interactive tier cannot run in any headless/CI context — App
  Connectors are unavailable there regardless of hosting location — and needs re-arming roughly
  every 7 days (a property of the scheduling tool, not of where it runs).

## Entry points

- `src/hybrid-index.js` — the current, combined pipeline. Routes each ticket in a batch to
  whichever specialist applies (image swap, CMS text, static element), instead of running two
  separate label-filtered passes. This is what should be used going forward.
- `src/index.js` and `src/image-index.js` — the older, split text-only / image-only pipelines
  that `hybrid-index.js` superseded. Kept for reference; not the intended entry point anymore.
- `scripts/revert-ticket.js` — parses a ticket's own "Automated Update Applied" comment to recover
  and undo a bad write. Known gap: doesn't update `progress/discovery-seen.json` or apply an
  exclusion label after reverting, so a manually-reverted ticket can get rediscovered and
  reprocessed later (confirmed: this happened twice to the same ticket).

## `.env` gotcha

`DRY_RUN=true` is the resting default in `.env` (`.env.example` documents the real default as
`false`). Any command that should actually write must explicitly pass `DRY_RUN=false` — relying
on `.env` alone silently no-ops. Confirmed: a real retry batch ran as a complete no-op because
this was forgotten. Always check the run's log banner for `(DRY RUN)` before trusting its outcome.

## Safety mechanisms already in place, and why

1. **AI diagnosis (`src/ai-resolver.js`'s `diagnoseRequest`) gates every write.** It classifies a
   ticket's raw description as `literal` / `partial` / `new_item` / `structural` / `not_visual` /
   `ambiguous` before anything downstream treats it as replacement text. Without it, instructions
   ("remove this FAQ"), partial-edit requests, quote-wrapped text, and "add a new item" requests
   all got written verbatim into unrelated fields — confirmed, repeatedly, before this existed.
   Runs on OpenAI (`gpt-4o-mini`) only, never Claude/Anthropic — a deliberate cost choice; don't
   add an Anthropic-key code path without checking first.

2. **RichText scope-mismatch guard (`src/cms-updater.js`, `resolveCmsTarget`).** `literal`
   classification only confirms the text itself isn't an instruction — it does NOT confirm the
   match is the right *size* for the target field. A short heading matched against a multi-section
   RichText field will silently overwrite the whole block. The guard fails the write if a RichText
   field's existing plain-text length is >250 chars and >3x the new value's length. This caught
   real, repeated damage (the same ticket corrupted the same way three separate times before the
   guard existed).

3. **`ai:out-of-scope` and `ai:duplicate` Linear labels are hard exclusions**, same tier as
   `ai:edited` — never let "ignore labels, just check state" override them. They mark tickets an
   upstream/human process already triaged as unsafe or duplicate. Confirmed real damage: 4
   duplicate tickets referencing the same BugHerd task, already carrying these labels, got
   reprocessed anyway and cascaded a bad hero-image overwrite 4 times before this exclusion
   existed.

4. **Image position-index matching (`#idN` / bugherd-id) is permanently removed** from
   `src/image-item-resolver.js` after confirmed wrong matches in production (human QA report).
   Do not re-add it. Only the explicit `collection-item-N` class tier is reliable — it's list-local;
   `#idN` was page-global and didn't correspond to item position.

5. **Retry/backoff is implemented in all three API clients** (`webflow-client.js`,
   `linear-client.js`, `bugherd-client.js`) for network errors and 429/5xx. A bare uncaught network
   exception previously crashed a live batch run mid-way through. `pollTicketsByState` paginates
   internally — it used to be capped at whatever `limit` was passed, silently truncating a
   330-ticket queue to 250.

## The big one: headless component/image/link edits (2026-07-10)

It was wrongly assumed that Webflow element edits (text/image/link, including inside Component
definitions) require a live Designer session and can't run headlessly. **That's half true and the
half that's false matters a lot:**

- Via the Anthropic-hosted Webflow MCP connector (`data_element_tool`, `data_pages_tool`,
  `data_sites_tool` — only available inside a Claude session with that connector attached, NOT
  from a plain Node script), headless edits to text, images, and links — including elements
  inside Component definitions via `scope_component_id` — were confirmed working live, repeatedly,
  on primary (not secondary/translation) locale content. This unlocked real tickets that a
  REST-only pipeline had been correctly giving up on.
- Webflow's own *public* Data API v2 does NOT support this. It has real server-side write
  endpoints (`POST /v2/pages/{id}/dom`, `POST /v2/sites/{id}/components/{id}/dom`), but their docs
  say primary-locale content "must be updated through the Webflow Designer" — API writes are
  restricted to secondary (translation) locales, and the write schema is text-only (no image or
  link node types). A plain API token in a plain script cannot replicate what the MCP connector
  did. Confirmed by reading Webflow's docs directly, not inferred.
- So: **REST-only automation (this codebase, run unattended) and MCP-powered automation (a live
  Claude Code session with the Webflow connector) are two different capability tiers, not one.**
  Don't assume a scheduled/unattended run has the second tier's power unless it's actually running
  as a Claude session with that connector attached (not GitHub Actions calling the raw Anthropic
  API, not a plain cron job).
- Two categories were tested and are OFF-LIMITS even for an MCP-powered session, confirmed by
  repeated permission-classifier denials, not just caution: (a) editing one line of a multi-line
  paragraph where lines are separate String children around `<br>` — no safe partial-edit path
  exists; (b) overwriting an `HtmlEmbed`/`w-embed`'s raw `code` setting to change a text fragment
  inside it, even when the full current code was verified first — embeds often bundle
  scripts/iframes alongside visible text, and a full-code overwrite risks silently deleting that.

### Recipe for a headless image swap (MCP-powered session only)

1. Resolve the target element's exact asset ID via `query_elements`/`get_settings`, cross-check
   against the fileId embedded in the ticket's original HTML (a hard fingerprint — stronger than
   filename/alt-text matching, which fails whenever the live content has drifted from the ticket's
   stale snapshot).
2. Upload the new image via direct Data API (`POST /sites/{id}/assets` → presigned S3 POST) —
   `asset_tool.upload_image_by_url` is NOT reliable, it errors trying to reach a Designer session.
3. **Poll `GET /v2/assets/{id}` and confirm `size > 0` before referencing the asset anywhere.**
   Confirmed reproducibly: the S3 upload can return 201 while Webflow's own asset record stays
   permanently stuck at `size: 0`. Referencing a broken asset in a CMS field write fails with
   `400 Bad Request: Missing fields`. Abort rather than write if the size never lands.
4. `data_element_tool > set_image_asset` (or `updateCollectionItem` for a genuine CMS field) with
   the verified asset ID.
5. Publish (`data_sites_tool > publish_site`, or `publishToStaging` for the REST path).

Also: a PATCH that re-sends a field's own existing value is NOT a safe no-op — it can trigger
Webflow to silently re-host the image under a new asset ID/URL with a garbled, double-URL-encoded
filename. Don't PATCH an Image field "just to check."

### Network flakiness note

The Webflow API was highly unstable for a stretch on 2026-07-10 (`ECONNRESET`,
`ConnectTimeoutError`, `BodyTimeoutError` on otherwise-correct requests, especially around larger
uploads). A failed call is not evidence the approach is wrong — retry the exact same call before
concluding anything, and distinguish network-layer errors from real API error bodies (like
`400 Missing fields`, which is a different, reproducible problem).

## Link-target changes (2026-07-10)

CMS-bound link swaps are now a first-class capability, not an automatic disqualification:

- `diagnoseRequest` (`ai-resolver.js`) has a `link_swap` type, distinct from the existing
  "points to an external URL as the *content source*" `ambiguous` case — the distinguishing
  signal is whether the URL is a new link *destination* vs. something to copy text from. Its
  `cleanValue` is validated to actually be a `https?://` URL before being trusted; if the model
  returns something else, it's downgraded to `ambiguous` rather than writing garbage into a Link
  field.
- `updateCmsLinkTarget` (`cms-updater.js`) resolves and writes CMS `Link`-type fields. It matches
  by comparing each candidate Link field's *current* value against the `oldHref` extracted from
  the ticket's HTML snapshot — not text content, since an item can have several parallel Link
  fields (confirmed: a Programs item had 3, only one matching what a given ticket meant). This is
  a separate, purpose-built matcher, not a change to `resolveFieldWithAI`'s general text-field
  resolver (which still correctly excludes Link fields from AI text-guessing).
- `ticket-processor.js`'s `handleLinkSwap` only ever attempts a CMS write. A `link_swap` diagnosis
  on a route that isn't CMS-bound (`routeTicket(...).path !== 'cms'`) skips immediately with a
  clear reason — static link hrefs have no REST write path at all (Webflow's public Data API has
  no link-write node type), so don't try, just say so.
- Component-internal Link *settings* (e.g. a `NavbarLink`'s href) are still only writable via the
  MCP-powered path from an interactive session — `set_link` itself rejects some Link-like element
  types (e.g. `NavbarLink`); fall back to `set_settings` with `key: "link"` + `static_link` in that
  case (confirmed working). That path isn't in this codebase since it can't run headlessly (see
  above) — it's a manual/interactive-session technique, documented here so it isn't re-discovered
  from scratch next time.

## Known gaps / next work

- `.github/workflows/run.yml` still runs the old `src/index.js` (text-only), and its secrets list
  is missing `OPENAI_API_KEY` and `CLOUDINARY_CLOUD_NAME` — if its schedule were re-enabled as-is,
  it would run with **no AI diagnosis at all**, exactly the safety gate everything above depends
  on. Fix this before ever re-enabling its cron trigger.
- `src/index.js` and `src/image-index.js` are superseded by `hybrid-index.js` but still present;
  worth deprecating explicitly (update `package.json` scripts and the GH workflow to point at
  `hybrid-index.js`) rather than leaving three entry points that can drift out of sync.
- No durable, always-on way to keep the MCP-powered capability tier running unattended exists yet
  — see the autonomy-architecture discussion in project memory/chat history from 2026-07-10.
  `CronCreate`-based self-scheduling works but is session-scoped (dies when the session closes,
  auto-expires after 7 days). Anthropic's Routines product is the documented path for durable
  MCP-connector-backed scheduling; local headless Claude Code (`-p`) explicitly cannot use
  OAuth-based App Connectors ("bare mode skips OAuth and keychain reads" — confirmed from
  Anthropic's own headless-mode docs), so Task Scheduler + headless Claude Code does not preserve
  the Webflow connector capability, only REST-reachable capability.
