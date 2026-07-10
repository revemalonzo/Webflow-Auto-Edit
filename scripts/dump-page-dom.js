/**
 * Diagnostic: dump full DOM for a page, recursively expanding children.
 * Usage: node scripts/dump-page-dom.js <pageId>
 *   e.g. node scripts/dump-page-dom.js 6a037f5eeb22d19bfee783bc
 */
import 'dotenv/config';

const WEBFLOW_BASE = 'https://api.webflow.com/v2';
const PAGE_ID = process.argv[2];
if (!PAGE_ID) {
  console.error('Usage: node scripts/dump-page-dom.js <pageId>');
  process.exit(1);
}

const token = process.env.WEBFLOW_API_TOKEN_1;

async function wfGet(path) {
  const res = await fetch(`${WEBFLOW_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'accept-version': '1.0.0' },
  });
  const text = await res.text();
  if (!res.ok) { console.error('API error:', text); process.exit(1); }
  return JSON.parse(text);
}

const dom = await wfGet(`/pages/${PAGE_ID}/dom`);
console.log('\n=== Raw top-level keys ===');
console.log(Object.keys(dom));

const nodes = dom.nodes ?? dom.elements ?? [];
console.log(`\n=== Total nodes: ${nodes.length} ===`);
if (dom.pagination) console.log('Pagination:', JSON.stringify(dom.pagination));

// Print first 3 nodes in full to understand the shape
console.log('\n=== First 3 nodes (raw JSON) ===');
for (const n of nodes.slice(0, 3)) {
  console.log(JSON.stringify(n, null, 2));
}

// Print all text nodes (type=text) — these are the editable ones
console.log('\n=== All text nodes ===');
for (const n of nodes) {
  if (n.type === 'text') {
    console.log(JSON.stringify(n, null, 2));
  }
}

// Print component-instance nodes
console.log('\n=== Component instances ===');
for (const n of nodes) {
  if (n.type === 'component-instance') {
    console.log(JSON.stringify(n, null, 2));
  }
}
