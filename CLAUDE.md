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
  inside it when the embed's full code is NOT read first, or when it bundles more than the visible
  text (scripts/iframes/other markup) — a full-code overwrite in that case risks silently deleting
  the part you didn't check.
  **REFINED 2026-07-13 (BUGHERD-51245, CrossFit Park Ave):** this is not an absolute ban on w-embed
  writes — it's a ban on writing one *without verifying the embed's entire current code first*.
  Confirmed safe and correct: read the embed's raw `code` via `get_settings` before touching
  anything; if the ENTIRE code is exactly the one visible text fragment (no other tags, no
  script/iframe siblings), a full-code overwrite is equivalent to a plain text replacement and
  carries none of the risk this rule exists to prevent. Procedure that worked: (1) rule out a CMS
  binding first — check whether a plausibly-matching CMS field exists on the collection, and if it
  does, compare its actual current value against the embed's text; a field that merely has a
  similar-sounding name (e.g. `areas-served`) is not proof it's the source — this ticket's
  `areas-served` CMS field held a completely different, unrelated value, confirming the embed was
  genuinely standalone, not CMS-bound; (2) `get_settings > all_raw_settings` on the embed element to
  read the full `code` value; (3) only if step 2 shows nothing but the target text, write the full
  replacement via `set_settings` (key `code`, same wrapping tag/classes, only the text changed);
  (4) re-read the setting to confirm the write landed before publishing. Don't skip straight to
  "needs bridge app" on an embed match — do steps 1-2 first, every time.

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
   **2026-07-14: hit this 7 times in one afternoon across 4 unrelated sites** (CrossFit SHP x2,
   Stone Strength Lab x2, Koda OKC x1, RISE Athletics x1, East Ridgefield CrossFit x1) working the
   backlog — every single fresh-upload image-swap ticket attempted that day failed this way,
   including retries on the same file (reusing an already-uploaded file by filename match, when
   possible, worked fine — it's specifically new uploads that stuck at `size: 0`). That hit rate is
   high enough it's worth treating as "Webflow's asset pipeline may be degraded right now" rather
   than "this specific file/site is broken" — check for a run of image-swap failures across
   unrelated sites in a short window as a signal to pause new-upload image work and retry later,
   rather than concluding each ticket individually needs manual handling.
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

## The `.w-richtext` cache-poisoning incident (2026-07-10/11)

**Real production corruption, root-caused and fixed.** `learnFieldMapping`/`learnElementMapping`/
`learnImageFieldMapping` (`ai-resolver.js`) all picked the CSS class to cache via
`selector.match(/\.([\w-]+)/g).at(-1)` — the *last* class in the selector. Webflow's own
auto-generated utility classes (`w-richtext`, `w-dyn-item`, `w-inline-block`, `w-container`,
`w-embed`, etc. — anything Webflow stamps onto every element of a given TYPE, not tied to any
specific field) are reliably the LAST class when a meaningful custom class is also present
(`class="pricing-and-details w-richtext"`), so this heuristic learned "Programs + `.w-richtext`
means `program-description-rt`" from one legitimately-matching ticket, then every later, unrelated
ticket whose selector happened to end in `.w-richtext` on the Programs collection hit that same
cache entry and got silently routed to `program-description-rt` — regardless of what field it
actually should have hit. Confirmed real damage: two items on a live site had their real
program-description RichText content overwritten down to a bare price string ("$109/month") by
tickets that were actually trying to update a completely different field
(`pricing-and-details-2`), whose own selector also happened to end in `.w-richtext`.

**Fixed:** added `pickCacheableClass()` in `ai-resolver.js`, used by all three `learn*Mapping`
functions, which filters out any class matching `^\.w-` before picking the last one. Purged 12
already-poisoned cache entries across `field-mappings.json` (6), `element-mappings.json` (2), and
`image-field-mappings.json` (4) — every entry across all three files whose cached `cssClass` was a
bare Webflow utility class, not just the ones with confirmed damage. `matchFieldBySelector`
(`cms-updater.js`, the live heuristic matcher, not the cache) does NOT have this bug — it requires
an exact match against a real field slug, and utility classes never coincidentally equal one.

**Recovery patterns worth knowing, in order of preference:**

1. **Check the live production domain directly, not staging.** This pipeline only ever calls
   `publishToStaging` — it never publishes to the real custom domain. So the actual production
   site (e.g. `https://www.crossfitlynchburg.com/...`, not the `.webflow.io` staging URL) is
   completely untouched by any bad write this pipeline makes, until someone manually publishes
   staging to live. A plain `curl` of the live page's HTML recovered an exact, verbatim, zero-guess
   original for a RichText field that ticket history alone couldn't reconstruct — this should be
   the FIRST recovery attempt, before concluding anything is unrecoverable.
2. **Search the full ticket history for the same page/item, not just the most recent tickets that
   touched it.** The pipeline's own "Automated Update Applied" Linear comments record the full old
   value on every write — an earlier ticket (processed before a corruption cascade, itself once a
   "first, correct" write against the real field) may have captured the true original content
   verbatim in its own comment, even if the more recent tickets' recorded "old value" is already
   corrupted.
3. Only if neither source has it: ask the user, and do not fabricate replacement content.

**Standing lesson for any future cache-learning code:** never cache a mapping keyed on a class that
Webflow itself generates as a structural/framework marker (anything `w-`-prefixed). Only meaningful,
author-supplied custom classes are safe to use as a durable, cross-ticket cache key.

## Don't stop at "revert the wrong write" — actually try to resolve the real target (2026-07-11)

When a QA-failed ticket's wrong write gets reverted, the temptation is to report the real request as
"needs manual handling" and stop there. Confirmed repeatedly the same session: with real effort, most
of these WERE resolvable, just not by the first-pass heuristics. Patterns that worked:

- **A field can be a clean, unambiguous full-value match even when the request looks like a "partial
  edit."** A ticket asking to change "$35.00/Session" to "$25 a session" looks like a partial edit of
  a larger block — but if the target RichText field's ENTIRE content is exactly `<h3>$35.00/Session</h3>`
  and nothing else, a full-field write is exactly correct, not a scope-mismatch risk. Check the field's
  actual current value before assuming a size-based guard should block it.
- **When the ticket's own recorded selector/snapshot doesn't match anything on the live page, search
  the FULL page structure (`get_all_elements`), not just a keyword/text search for words from the
  ticket.** A search for the literal word "believe" found nothing on a page that, in full-tree view,
  turned out to already have a "what we believe"-shaped section under a *different* heading
  ("WHY MAVERICK EXISTS" instead of "WHAT WE BELIEVE") — the client's request was, naturally, asking
  to change wording that's no longer the current wording, so searching for the NEW wording will
  always miss. Read structure, don't just grep for the request's own words.
- **A compound request (new headline + new body copy) often maps to two different techniques in the
  same section**: a static heading (plain Designer element, MCP `set_text`) paired with a CMS-bound
  RichText body directly beneath it (`updateCollectionItem`). Don't assume the whole section is one
  or the other — check each piece.
- **If a Linear ticket shows "No attachments" but a QA comment references an image the client
  attached, check the underlying BugHerd task directly** (`getTaskDetails`) — the file may exist there
  and simply never have synced into the Linear ticket description.
- **Webflow's CMS Image field API rejects a bare external URL** (`{ url: "https://files.bugherd.com/..." }`
  fails with `400 Missing fields`) — it needs to go through Cloudinary's fetch-transform proxy
  (`cloudinary.js`'s `getImageUrls`, exactly like the existing image pipeline already does), not a raw
  source URL, even though the field only ever stores a plain URL string either way.
- **The permission classifier's stated reasoning is not infallible** — it once described verbatim,
  ticket-provided copy as "fabricated content never provided by the client." The right response was
  not to argue past the block or route around it, but to respect the block, point out the specific
  factual disagreement to the user, and let them decide — which is exactly what surfaced the
  confirmation needed to proceed correctly.

## Wrong-field writes beyond the cache-poisoning bug (2026-07-11)

Not every wrong-field write this week traced back to the `.w-richtext` cache bug above — several
were separate, confirmed issues, found by actually checking live CMS state rather than trusting a
ticket's own "Automated Update Applied" comment as proof the write landed somewhere sensible:

- **`programs-home` image type: the resolver could land on the wrong image field even when a
  reliable deterministic signal existed.** Programs collections commonly have 3 image-ish fields
  (`image`, `image-mobile`, `program-image-home`) that a class/id heuristic or the AI fallback
  can't reliably tell apart. `image-processor.js` already had a "prefer the field with `home` in
  its slug" override for this image type, but it only fired as a *last resort*
  (`!kbMatch && !primarySlug`) — so a wrong-but-non-null heuristic/AI match for `image-mobile`
  silently won anyway. Confirmed on two separate Fitcorps Training Center tickets (BUGHERD-51187,
  51190): the new photo landed on the program's detail-page mobile-hero field while the actual
  homepage "Top Programs" card field (`program-image-home`) stayed on the old photo — QA correctly
  reported "no changes" because they were looking at the card the client meant, not the field that
  changed. **Fixed:** the home-slug preference is now unconditional for `programs-home`, not a
  fallback. Standing lesson: when a genuinely reliable deterministic signal exists for a field
  choice, it should override AI/heuristic results outright, not just fill in when they're silent.
- **Generic single-segment→"Pages - Hero Sections" routing keeps misrouting long-form About-page
  content on sites that also have a dedicated About-page RichText field.** Confirmed on three
  separate sites this week (PSP3, MRG MMA, and the earlier Bridge Performance/Tusky
  Valley/crossfitlynchburg cache-poisoning cases): a founder-story/about-us-shaped request landed
  on a page's generic hero `paragraph` field (often overflowing its container, since hero
  paragraphs are meant to be one short line) instead of the real, purpose-built RichText section
  (`Main templates → about-us`, rendered under a static "About the gym"/"About our School"
  heading). The fix each time was the same: read the live page's full element tree
  (`get_all_elements`) to find the real RichText target, write there, and either restore or clear
  the wrongly-hit hero paragraph (restore if the original value was recorded; clear to null,
  never fabricate, if it wasn't — several sibling hero items on the same collection already have a
  null paragraph, confirming that's a valid state, not a broken one).
- **When "fixing" a wrong write, always re-read the field's CURRENT live value before writing —
  never trust a stale ticket-comment history for what "correct" looks like.** Confirmed twice this
  session: (1) on PSP3, an initial fix attempt fully replaced an existing, legitimate founder bio
  with new ticket content instead of appending it — caught immediately by noticing the destroyed
  text was specific and clearly not placeholder, self-corrected before it shipped. (2) On a Rookies
  Kids Fitness ticket (BUGHERD-51299), an old "Automated Update Applied" comment described a flat
  content overwrite that looked fabricated — but checking the *live* field showed a human editor
  had since reorganized it into a sensible two-section structure. Reverting to the old comment's
  "original" value would have destroyed that legitimate follow-up work. Always diff against
  current live state, not historical comments, before deciding a write is wrong.
- **A diagnosis call is not deterministic even on identical input.** The same ticket (an empty
  `<div class="hero-img-overlay">` with a real image attached) was diagnosed differently — literal,
  ambiguous, structural — across three separate calls with otherwise identical input. None of the
  five OpenAI calls in `ai-resolver.js` set `temperature`, so they ran at the default (1.0).
  **Fixed:** all five now set `temperature: 0`. This doesn't guarantee determinism, but it removes
  a meaningful source of flip-flopping — treat any pattern that still disagrees with itself at
  temperature 0 as a genuinely hard case, not noise to route around.
- **A single rate-limited `publishToStaging` call could crash the entire run, not just that one
  batch.** `main()`'s only top-level catch calls `process.exit(1)` — so a 429 on one site's publish
  (confirmed: hitting the same site's publish endpoint repeatedly across several back-to-back
  batches triggers this) killed every remaining ticket in the run, even ones on completely
  unrelated sites, even though their CMS writes had already succeeded and just weren't published
  yet. **Fixed:** `processBatch`'s publish call is now wrapped in its own try/catch — a publish
  failure logs loudly and the run continues; the CMS write itself is not lost, just not yet
  pushed to the staging preview. If you're intentionally running many tickets for the *same* site
  back-to-back (e.g. a targeted retry batch via `HYBRID_BATCH_URLS`), space them out or expect to
  need a manual consolidating publish afterward — this fix stops the crash but doesn't add
  publish-level rate-limit backoff.

## Known gaps / next work

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
- **Righteous Wellness: several page elements (map heading/subheading, a "Reviews" heading) are
  built as a single shared Component instance reused across all 8 program pages plus the homepage,
  not per-page CMS fields (2026-07-14).** Confirmed while working the site's backlog: 9 tickets
  wanted different text for these elements on different program pages, but writing any of them
  would change the text everywhere the component is placed, not just the one page the ticket is
  about — three tickets (50620/50602/50558) even want three different, mutually exclusive values
  for the literal same shared map-subheading element. This is not a "try harder to find the real
  field" case like the About-page misroutes elsewhere in this doc — there IS no per-page field to
  find; the site would need restructuring (turn the shared heading/subheading into real per-program
  CMS-bound fields) before these are automatable, or a human needs to pick one winning value per
  shared element and close the rest as duplicates/wontfix. Left all 9 tickets untouched in the
  Live Edits Queue pending that decision.
- **LiveFIT 901: the same shared-Component pattern recurred (2026-07-14)** — a "Final Offer
  Section" is one Component instance reused across every page, with its image bound to an internal
  CMS-bound collection list rather than a per-page field. 7 tickets each asking to swap that
  section's photo to a different attached image were left untouched for the same reason as
  Righteous Wellness's map/reviews headings: writing any one of them would change the image
  everywhere the component is placed. Worth checking whether these two sites share a template
  origin, since the same structural gap appearing twice suggests it may be a common pattern across
  this agency's site template family, not a one-off.
