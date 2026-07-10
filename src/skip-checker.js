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

  // H1 tag — only allow if the new value follows the SEO pattern:
  // "<gym type/program> in <City>, <State>" e.g. "CrossFit Gym in Leeds, AL"
  if (htmlSnapshot.includes('<h1') || htmlSnapshot.includes('<H1')) {
    const h1Pattern = /\bin\s+[A-Z][a-zA-Z\s]+,?\s+[A-Z]{2}\b/;
    if (!h1Pattern.test(newValue)) {
      return skip(
        'Warning: Automation skipped -- H1 changes must follow the format "<type> in <City>, <State>" (e.g. "CrossFit Gym in Leeds, AL").'
      );
    }
    // Passes — allow through to normal routing
  }

  // w-embed in selector -- check before the generic iframe/embed check below,
  // since "w-embed" also contains the substring "embed" and would otherwise
  // always be caught by the less specific message first.
  if (selector.includes('w-embed')) {
    return skip('Warning: Automation skipped -- w-embed element. Not editable via API. Needs manual Webflow Designer edit.');
  }

  // iframe / embed
  if (htmlSnapshot.includes('<iframe') || selector.includes('embed')) {
    return skip('Warning: Automation skipped -- iframe/embed elements are out of scope.');
  }

  // Page removal / element deletion
  if (!newValue || newValue.trim() === '' || /^(delete|remove|hide|none)$/i.test(newValue.trim())) {
    return skip('Warning: Automation skipped -- page/element removal is out of scope.');
  }

  // Layout/structural instruction, not literal replacement text -- confirmed real
  // case: tickets whose "Description" field is an instruction like "remove and
  // center the buttons" or "delete and move the phone number to the middle" get
  // matched by the static/CMS resolvers (which just look for A text element to
  // write to) and would otherwise have that instruction written verbatim into an
  // unrelated heading/CTA field. Repositioning/removing elements is a Designer-only
  // change (no text field to write), so catch it before any resolver runs.
  const layoutVerb = /^(remove|delete|move|shift|center|align|reposition|hide)\b/i;
  const layoutNoun = /(button|buttons|form|phone number|logo|image|icon|section|element|div|widget)/i;
  if (layoutVerb.test(newValue.trim()) && layoutNoun.test(newValue)) {
    return skip('Warning: Automation skipped -- this reads as a layout/positioning instruction (move/remove/center an element), not literal replacement text. Requires manual Webflow Designer edit.');
  }

  // Link-target change, not display text -- confirmed real case: "I need the
  // button link to go to the following link to register: <url>" gets matched
  // against the button's plain-text LABEL field (via text-value match against the
  // OLD label) and fails validation as multi-line text. The actual request is to
  // repoint a Link-type setting, which this pipeline doesn't write.
  if (/\blink\b/i.test(newValue) && /https?:\/\//i.test(newValue)) {
    return skip('Warning: Automation skipped -- this reads as a request to change a link/button\'s target URL, not its display text. Requires manual Webflow Designer edit (Link field, not Text).');
  }

  // Instruction/commentary, not literal replacement text -- confirmed real,
  // widespread damage: tickets whose "Description" field is an instruction
  // directed AT THE EDITOR ("Add a sentence after...", "change this to say...",
  // "arrange the programs in this order...", "Can we change this to say...")
  // were written VERBATIM as the new field value, replacing correct content with
  // meta-commentary, or (worse) replacing an entire rich-text block when the
  // instruction only asked to add/tweak one sentence within it. Catch this before
  // any resolver runs -- do not attempt to auto-extract a literal value from it
  // (that guess is exactly what caused the damage); require manual review instead.
  const instructionSignals = [
    /^(can we|could we|could you|should we|i think|we think|let'?s|please\s+(can|could))\b/i,
    /\b(change (it|this|the \s*\w+) to\b|change (it|this) to say\b|update (it|this) to say\b|make (it|this) say\b)/i,
    /\barrange\b.*\bin (this|that) order\b/i,
    /\badd (a|another) (sentence|page|section|paragraph)\b/i,
    /\bunder\s+"[^"]+"\s+change\b/i,
    /\?\s*$/,
  ];
  if (instructionSignals.some((re) => re.test(newValue))) {
    return skip('Warning: Automation skipped -- this reads as an instruction/question directed at an editor, not literal replacement text (e.g. "change this to say...", "add a sentence...", "arrange...in this order"). Writing it verbatim would corrupt the field. Requires manual review to determine the actual intended text.');
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
