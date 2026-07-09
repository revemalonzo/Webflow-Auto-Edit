/**
 * Evaluates pre-flight skip conditions for a ticket.
 * Returns { skip: true, reason: string } or { skip: false }.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// skipRules loaded but checks are implemented inline for performance
const _skipRules = require('../knowledge-base/skip-rules.json'); // eslint-disable-line no-unused-vars

/**
 * Run all skip checks against a ticket's data.
 *
 * @param {object} ticket
 * @param {string} ticket.selector     - CSS selector path
 * @param {string} ticket.htmlSnapshot - HTML snapshot from ticket
 * @param {string} ticket.newValue     - Requested new text value
 */
export function checkSkipConditions(ticket) {
  const { selector = '', htmlSnapshot = '', newValue = '' } = ticket;

  // H1 tag
  if (htmlSnapshot.includes('<h1') || htmlSnapshot.includes('<H1')) {
    return skip('Warning: Automation skipped -- H1 tag changes are out of scope.');
  }

  // iframe / embed
  if (htmlSnapshot.includes('<iframe') || selector.includes('embed')) {
    return skip('Warning: Automation skipped -- iframe/embed elements are out of scope.');
  }

  // w-embed in selector
  if (selector.includes('w-embed')) {
    return skip('Warning: Automation skipped -- w-embed element. Not editable via API. Needs manual Webflow Designer edit.');
  }

  // Photo / image change
  const imagePhrases = ['image', 'photo', 'logo', 'icon', 'picture', 'banner', 'thumbnail'];
  if (imagePhrases.some((p) => newValue.toLowerCase().includes(p) || htmlSnapshot.includes('<img'))) {
    return skip('Warning: Automation skipped -- image changes are not yet automatable.');
  }

  // Page removal / element deletion
  if (!newValue || newValue.trim() === '' || /^(delete|remove|hide|none)$/i.test(newValue.trim())) {
    return skip('Warning: Automation skipped -- page/element removal is out of scope.');
  }

  // Non-inferrable new value
  const vaguePhrases = [
    'update from website',
    'see attachment',
    'see screenshot',
    'refer to',
    'check website',
    'tbd',
    'to be determined',
  ];
  if (vaguePhrases.some((p) => newValue.toLowerCase().includes(p))) {
    return skip('Warning: Automation skipped -- new value not inferrable from ticket.');
  }

  return { skip: false };
}

function skip(reason) {
  return { skip: true, reason };
}
