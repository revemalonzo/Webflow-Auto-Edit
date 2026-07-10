/**
 * Diagnostic: fetch and print all field slugs for a named collection.
 *
 * Usage:
 *   node scripts/fetch-collection-fields.js "FAQs"
 *   node scripts/fetch-collection-fields.js "Programs"
 */

import 'dotenv/config';
import { listCollections, getCollectionFields } from '../src/webflow-client.js';

// Site ID for righteous-wellness (from previous run)
const SITE_ID = '6a037f56eb22d19bfee782ca';

const collectionName = process.argv[2];
if (!collectionName) {
  console.error('Usage: node scripts/fetch-collection-fields.js "<CollectionName>"');
  process.exit(1);
}

async function main() {
  // Use token 1 (the one that has access to righteous-wellness)
  const token = process.env.WEBFLOW_API_TOKEN_1;

  console.log(`Listing collections for site ${SITE_ID}...`);
  const all = await listCollections(SITE_ID, token);
  console.log(`Found ${all.length} collections:`);
  for (const c of all) {
    console.log(`  ${c.displayName} (slug: ${c.slug}, id: ${c.id})`);
  }

  const match = all.find(
    (c) => c.displayName === collectionName || c.slug === collectionName
  );
  if (!match) {
    console.error(`\nCollection "${collectionName}" not found.`);
    process.exit(1);
  }

  console.log(`\nFields for "${match.displayName}" (${match.id}):`);
  const fields = await getCollectionFields(match.id, token);
  for (const f of fields) {
    console.log(`  slug: "${f.slug}"  displayName: "${f.displayName}"  type: ${f.type}`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
