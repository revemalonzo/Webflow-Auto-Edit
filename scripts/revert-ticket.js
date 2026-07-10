/**
 * Safety-net revert tool. Given one or more Linear ticket identifiers, parses
 * this pipeline's own "Automated Update Applied" / "Image Swap Applied" comment
 * (which always records the pre-edit value for exactly this purpose), reverts
 * the live Webflow field back to it, republishes to staging, and cleans up
 * Linear (deletes the Applied comment, strips ai:edited, resets state to
 * Live Edits Queue).
 *
 * Never guesses -- if a ticket's Applied comment can't be found or parsed, it's
 * reported and left untouched for manual handling.
 *
 * Usage:
 *   node scripts/revert-ticket.js BUGHERD-12345 BUGHERD-12346 ...
 *   DRY_RUN=true node scripts/revert-ticket.js BUGHERD-12345   # preview only
 */
import 'dotenv/config';
import { getIssue } from '../src/linear-client.js';
import { resolveSite, listCollections, listCollectionItems, updateCollectionItem, publishToStaging } from '../src/webflow-client.js';

const DRY_RUN = process.env.DRY_RUN === 'true';
const LINEAR_BASE = 'https://api.linear.app/graphql';
const TOKEN = process.env.LINEAR_API_KEY;

async function gql(query, variables = {}) {
  const res = await fetch(LINEAR_BASE, {
    method: 'POST',
    headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const AI_EDITED_ID = 'd772b67f-d625-48e3-bb7c-d857182a8f3b';
const LIVE_EDITS_QUEUE_ID = '93a7a9eb-b83b-4d27-8aab-7a37142be8bb';

function parseCmsComment(body) {
  const m = body.match(/Collection\s*->\s*Field:\s*(.+?)\s*->\s*(.+)\nItem:\s*(.+)\nOld value:\s*([\s\S]*?)\nNew value:/);
  if (!m || m[4].trim() === '(unknown)') return null;
  return { kind: 'cms', collection: m[1].trim(), fields: [{ slug: m[2].trim(), value: m[4].trim() }], itemName: m[3].trim() };
}

function parseImageComment(body) {
  const header = body.match(/\*\*Collection:\*\*\s*(.+?)\s*→\s*\*\*Field\(s\):\*\*\s*(.+)\n\*\*Item:\*\*\s*(.+)/);
  const oldUrl = body.match(/\*\*Old image URL\(?s?\)?:\*\*\s*(.+)/);
  if (!header || !oldUrl) return null;

  const collection = header[1].trim();
  const itemName = header[3].trim();
  const fieldSlugs = header[2].split(',').map((s) => s.trim());

  if (fieldSlugs.length === 2 && oldUrl[1].includes('desktop:') && oldUrl[1].includes('mobile:')) {
    const desktop = oldUrl[1].match(/desktop:\s*(\S+)/)?.[1];
    const mobile = oldUrl[1].match(/mobile:\s*(\S+)/)?.[1];
    if (!desktop) return null;
    return { kind: 'image', collection, itemName, fields: [
      { slug: fieldSlugs[0], value: { url: desktop } },
      ...(mobile && mobile !== '(none)' ? [{ slug: fieldSlugs[1], value: { url: mobile } }] : []),
    ] };
  }
  const url = oldUrl[1].trim();
  if (!url || url === '(none)') return null;
  return { kind: 'image', collection, itemName, fields: [{ slug: fieldSlugs[0], value: { url } }] };
}

async function revertTicket(identifier) {
  const issue = await getIssue(identifier);
  if (!issue) { console.log(`${identifier}: not found`); return; }

  const commentsData = await gql(
    `query($id:String!){issue(id:$id){comments(first:20,orderBy:createdAt){nodes{id body createdAt}}}}`,
    { id: identifier }
  );
  const comments = commentsData.issue.comments.nodes;
  const applied = [...comments].reverse().find((c) => c.body.includes('Applied'));
  if (!applied) { console.log(`${identifier}: no Applied comment found -- nothing to revert.`); return; }

  const parsed = parseCmsComment(applied.body) ?? parseImageComment(applied.body);
  if (!parsed) { console.log(`${identifier}: could not parse Applied comment (old value unknown or unrecognized format) -- skipping, needs manual revert.`); return; }

  // Prefer the Staging URL recorded in the Applied comment itself -- always a
  // webflow.io URL (guaranteed resolvable, no BugHerd fallback needed), and
  // present even on tickets whose own description never had a Page URL field.
  const stagingUrlMatch = applied.body.match(/\*\*Staging URL:\*\*\s*(\S+)/);
  const pageUrlMatch = stagingUrlMatch ?? issue.description?.match(/\*\*Page URL\*\*[:\s]*\[?(https?:\/\/[^\s\]>)]+)/i);
  if (!pageUrlMatch) { console.log(`${identifier}: no Page URL on ticket -- can't resolve site, skipping.`); return; }
  const hostname = new URL(pageUrlMatch[1]).hostname;
  const shortName = hostname.endsWith('.webflow.io') ? hostname.replace(/\.webflow\.io$/, '').split('.')[0] : null;
  const customDomain = shortName ? null : hostname.replace(/^www\./i, '');

  const siteInfo = await resolveSite(shortName, customDomain);
  const collections = await listCollections(siteInfo.siteId, siteInfo.token);
  const coll = collections.find((c) => c.displayName.toLowerCase() === parsed.collection.toLowerCase());
  if (!coll) { console.log(`${identifier}: collection "${parsed.collection}" not found on site -- skipping.`); return; }
  const items = await listCollectionItems(coll.id, siteInfo.token);
  const item = items.find((i) => i.fieldData?.name === parsed.itemName);
  if (!item) { console.log(`${identifier}: item "${parsed.itemName}" not found in "${parsed.collection}" -- skipping.`); return; }

  const fieldData = {};
  for (const f of parsed.fields) fieldData[f.slug] = f.value;

  if (DRY_RUN) {
    console.log(`[DRY RUN] ${identifier}: would revert ${parsed.collection}/${parsed.itemName} ->`, JSON.stringify(fieldData));
    return;
  }

  await updateCollectionItem(coll.id, item.id, fieldData, siteInfo.token, false);
  await publishToStaging(siteInfo.siteId, siteInfo.token, false);
  await gql(`mutation($id:String!){commentDelete(id:$id){success}}`, { id: applied.id });
  const labelIds = issue.labels.nodes.map((l) => l.id).filter((id) => id !== AI_EDITED_ID);
  await gql(
    `mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}`,
    { id: issue.id, input: { labelIds, stateId: LIVE_EDITS_QUEUE_ID } }
  );
  console.log(`${identifier}: reverted "${parsed.collection}"/"${parsed.itemName}" and cleaned up Linear.`);
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('Usage: node scripts/revert-ticket.js BUGHERD-12345 [BUGHERD-12346 ...]');
  process.exit(1);
}

for (const id of ids) {
  try {
    await revertTicket(id);
  } catch (err) {
    console.error(`${id}: revert failed -- ${err.message}`);
  }
}
