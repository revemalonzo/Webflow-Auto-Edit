/**
 * Diagnostic: list all pages for the site, showing id, slug, title, collectionId.
 * Usage: node scripts/list-pages.js
 */
import 'dotenv/config';
import { listPages } from '../src/webflow-client.js';

const SITE_ID = '6a037f56eb22d19bfee782ca';
const token = process.env.WEBFLOW_API_TOKEN_1;

const pages = await listPages(SITE_ID, token);
console.log(`Total pages: ${pages.length}\n`);
for (const p of pages) {
  console.log(`slug: "${p.slug ?? ''}"  title: "${p.title ?? p.name ?? ''}"  id: ${p.id}  collectionId: ${p.collectionId ?? 'null'}`);
}
