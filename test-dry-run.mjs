/**
 * Offline dry-run test — validates parsing, routing, and skip logic
 * against realistic ticket shapes without any API calls.
 *
 * Run: node test-dry-run.mjs
 */

import { routeTicket } from './src/router.js';
import { lookupFieldSlug } from './src/field-mapper.js';
import { checkSkipConditions } from './src/skip-checker.js';

// ─── Realistic ticket descriptions ────────────────────────────────────────────

const TICKETS = [
  {
    name: 'CMS heading change (Programs)',
    description: `### Task Details
**Task created on**: 2026-06-01T00:00:00.000Z
**Task ID**: 123
**Description**: Brazilian Jiu Jitsu in Austin, TX
**Page URL**: https://example-gym.webflow.io/programs/bjj
**Path**: section.main-hero > div.header-container > h1.header-subheading
**HTML**: <h2 class="header-subheading">Jiu Jitsu in Austin, TX</h2>
**Admin Link**: https://www.bugherd.com/projects/12345/tasks/678`,
  },
  {
    name: 'CMS hero heading change (Homepage)',
    description: `### Task Details
**Description**: Premier Fitness Studio in Denver, CO
**Page URL**: https://example-gym.webflow.io/
**Path**: div.hero-wrapper > h1.main-heading
**HTML**: <h1 class="main-heading">Fitness Studio Denver</h1>
**Admin Link**: https://www.bugherd.com/projects/12345/tasks/679`,
  },
  {
    name: 'SKIP — image change',
    description: `### Task Details
**Description**: Please change the banner image to the attached photo
**Page URL**: https://example-gym.webflow.io/about
**Path**: div.hero > img.banner-image
**HTML**: <img class="banner-image" src="old.jpg">
**Admin Link**: https://www.bugherd.com/projects/12345/tasks/680`,
  },
  {
    name: 'SKIP — H1 tag',
    description: `### Task Details
**Description**: New Gym Name
**Page URL**: https://example-gym.webflow.io/
**Path**: div.hero > h1.gym-type
**HTML**: <h1 class="gym-type">Old Gym Name</h1>
**Admin Link**: https://www.bugherd.com/projects/12345/tasks/681`,
  },
  {
    name: 'SKIP — w-embed element',
    description: `### Task Details
**Description**: New phone number
**Page URL**: https://example-gym.webflow.io/contact
**Path**: div.w-embed > span.phone
**HTML**: <span class="phone">555-0000</span>
**Admin Link**: https://www.bugherd.com/projects/12345/tasks/682`,
  },
  {
    name: 'Static path (about page)',
    description: `### Task Details
**Description**: About us — we are a premier fitness community
**Page URL**: https://example-gym.webflow.io/about
**Path**: div.content-wrapper > p.description-text
**HTML**: <p class="description-text">We are a fitness studio.</p>
**Admin Link**: https://www.bugherd.com/projects/12345/tasks/683`,
  },
  {
    name: 'SKIP — vague new value',
    description: `### Task Details
**Description**: update from website
**Page URL**: https://example-gym.webflow.io/programs/yoga
**Path**: div.hero > h2.header-subheading
**HTML**: <h2 class="header-subheading">Yoga</h2>
**Admin Link**: https://www.bugherd.com/projects/12345/tasks/684`,
  },
  {
    name: 'CMS coaches page',
    description: `### Task Details
**Description**: Head Coach & Founder
**Page URL**: https://example-gym.webflow.io/coaches/john-smith
**Path**: div.coach-bio > p.coach-profession
**HTML**: <p class="coach-profession">Coach</p>
**Admin Link**: https://www.bugherd.com/projects/12345/tasks/685`,
  },
];

// ─── Field extraction ─────────────────────────────────────────────────────────

function extractTicketFields(description = '') {
  const get = (label) => {
    const re = new RegExp(
      `\\*\\*${label}\\*\\*[:\\s]+(.*?)(?=\\n\\*\\*[^*]+\\*\\*[:\\s]|$)`,
      'si'
    );
    const m = description.match(re);
    return m ? m[1].trim() : null;
  };

  const adminLink = get('Admin Link') ?? '';
  const bhMatch = adminLink.match(/projects\/(\d+)\/tasks\/(\d+)/);

  return {
    pageUrl: get('Page URL'),
    newValue: get('Description') ?? get('New Value') ?? get('New Text'),
    selector: get('Path'),
    htmlSnapshot: get('HTML'),
    bugherdProjectId: bhMatch?.[1] ?? null,
    bugherdTaskId: bhMatch?.[2] ?? null,
  };
}

// ─── Run tests ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const ticket of TICKETS) {
  const fields = extractTicketFields(ticket.description);
  const skipCheck = checkSkipConditions({
    selector: fields.selector ?? '',
    htmlSnapshot: fields.htmlSnapshot ?? '',
    newValue: fields.newValue ?? '',
  });

  let route = null;
  let fieldSlug = null;

  if (!skipCheck.skip && fields.pageUrl && fields.selector) {
    route = routeTicket(fields.pageUrl, fields.selector);
    if (route.path === 'cms' && route.collection) {
      fieldSlug = lookupFieldSlug(route.collection, fields.selector);
    }
  }

  // Print result
  const status = skipCheck.skip ? '⏭  SKIP' : route?.path === 'cms' ? '📦 CMS ' : '🔧 STATIC';
  console.log(`\n${status} | ${ticket.name}`);
  console.log(`  pageUrl:    ${fields.pageUrl ?? '(missing)'}`);
  console.log(`  newValue:   ${fields.newValue ?? '(missing)'}`);
  console.log(`  selector:   ${fields.selector ?? '(missing)'}`);

  if (skipCheck.skip) {
    console.log(`  reason:     ${skipCheck.reason}`);
  } else if (route) {
    console.log(`  path:       ${route.path}`);
    if (route.collection) console.log(`  collection: ${route.collection}`);
    if (fieldSlug)        console.log(`  fieldSlug:  ${fieldSlug}`);
    else if (route.path === 'cms') console.log(`  fieldSlug:  ⚠️  NOT IN KB`);
  }

  // Basic assertions
  let ok = true;
  if (!fields.pageUrl && !ticket.name.includes('SKIP')) {
    console.log('  ❌ FAIL: missing pageUrl');
    ok = false;
  }
  if (!fields.newValue) {
    console.log('  ❌ FAIL: missing newValue');
    ok = false;
  }
  if (ok) {
    console.log('  ✅ OK');
    passed++;
  } else {
    failed++;
  }
}

console.log(`\n─────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// =============================================================================
// Fix 1: Custom domain URL parsing
// =============================================================================
console.log('\n\n=== Custom Domain Parsing ===');

function parseSiteFromUrl(pageUrl) {
  const hostname = new URL(pageUrl).hostname;
  if (hostname.endsWith('.webflow.io')) {
    const shortName = hostname.replace(/\.webflow\.io$/, '').split('.')[0];
    return { shortName, customDomain: null };
  }
  const customDomain = hostname.replace(/^www\./i, '');
  return { shortName: null, customDomain };
}

const domainTests = [
  { url: 'https://my-gym.webflow.io/programs/bjj',  expect: { shortName: 'my-gym', customDomain: null } },
  { url: 'https://mygym.com/programs/bjj',           expect: { shortName: null, customDomain: 'mygym.com' } },
  { url: 'https://www.mygym.com/programs/bjj',       expect: { shortName: null, customDomain: 'mygym.com' } },
  { url: 'https://ten-10training.com/programs/bjj',  expect: { shortName: null, customDomain: 'ten-10training.com' } },
  { url: 'https://studio.webflow.io/about',          expect: { shortName: 'studio', customDomain: null } },
];

let domainPassed = 0, domainFailed = 0;
for (const t of domainTests) {
  const result = parseSiteFromUrl(t.url);
  const ok = result.shortName === t.expect.shortName && result.customDomain === t.expect.customDomain;
  console.log(`${ok ? '  OK' : '  FAIL'} ${t.url}`);
  if (!ok) {
    console.log(`       expected: ${JSON.stringify(t.expect)}`);
    console.log(`       got:      ${JSON.stringify(result)}`);
    domainFailed++;
  } else {
    domainPassed++;
  }
}
console.log(`Domain parsing: ${domainPassed} passed, ${domainFailed} failed`);
if (domainFailed > 0) process.exit(1);

// =============================================================================
// Fix 2: Shared Locations conflict detection
// =============================================================================
import { detectLocationsConflicts } from './src/conflicts.js';

console.log('\n=== Locations Conflict Detection ===');

function makeTicket(id, pageUrl, selector, newValue) {
  return {
    id,
    identifier: `BUGHERD-${id}`,
    description: `### Task Details\n**Page URL**: ${pageUrl}\n**Path**: ${selector}\n**Description**: ${newValue}\n**HTML**: <p class="address">${newValue}</p>\n**Admin Link**: https://www.bugherd.com/projects/123/tasks/${id}`,
  };
}

const conflictTests = [
  {
    name: 'Conflict: same Locations field, different values',
    tickets: [
      makeTicket('c1', 'https://gym.webflow.io/locations/main', '.header-subheading', '123 Main St'),
      makeTicket('c2', 'https://gym.webflow.io/locations/main', '.header-subheading', '456 Oak Ave'),
    ],
    expectConflict: true,
    expectCount: 2,
  },
  {
    name: 'No conflict: same Locations field, same value (idempotent)',
    tickets: [
      makeTicket('nc1', 'https://gym.webflow.io/locations/main', '.header-subheading', 'CoreFit Gym'),
      makeTicket('nc2', 'https://gym.webflow.io/locations/main', '.header-subheading', 'CoreFit Gym'),
    ],
    expectConflict: false,
    expectCount: 0,
  },
  {
    name: 'No conflict: single Locations ticket',
    tickets: [
      makeTicket('nc3', 'https://gym.webflow.io/locations/main', '.header-subheading', 'Only one'),
    ],
    expectConflict: false,
    expectCount: 0,
  },
  {
    name: 'No conflict: different collections (Programs), not Locations',
    tickets: [
      makeTicket('nc4', 'https://gym.webflow.io/programs/bjj', '.header-subheading', 'BJJ in Austin'),
      makeTicket('nc5', 'https://gym.webflow.io/programs/yoga', '.header-subheading', 'Yoga in Denver'),
    ],
    expectConflict: false,
    expectCount: 0,
  },
  {
    name: 'Partial conflict: only Locations tickets flagged, Programs untouched',
    tickets: [
      makeTicket('pc1', 'https://gym.webflow.io/locations/main', '.header-subheading', 'Value A'),
      makeTicket('pc2', 'https://gym.webflow.io/locations/main', '.header-subheading', 'Value B'),
      makeTicket('pc3', 'https://gym.webflow.io/programs/bjj', '.header-subheading', 'BJJ Description'),
    ],
    expectConflict: true,
    expectCount: 2, // only the 2 Locations tickets
  },
];

let conflictsPassed = 0, conflictsFailed = 0;
for (const ct of conflictTests) {
  const conflicts = detectLocationsConflicts(ct.tickets);
  const gotConflict = conflicts.size > 0;
  const ok = gotConflict === ct.expectConflict && conflicts.size === ct.expectCount;
  console.log(`\n  ${ok ? 'OK' : 'FAIL'} | ${ct.name}`);
  if (!ok) {
    console.log(`    expected: conflict=${ct.expectConflict} count=${ct.expectCount}`);
    console.log(`    got:      conflict=${gotConflict} count=${conflicts.size}`);
    conflictsFailed++;
  } else {
    console.log(`    conflicts: ${conflicts.size} ticket(s) flagged`);
    conflictsPassed++;
  }
}

console.log(`\nConflict detection: ${conflictsPassed} passed, ${conflictsFailed} failed`);
if (conflictsFailed > 0) process.exit(1);

console.log('\n=== ALL TESTS PASSED ===');
