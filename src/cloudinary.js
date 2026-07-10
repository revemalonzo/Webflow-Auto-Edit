/**
 * Cloudinary URL construction for the image updater -- no API calls, pure URL
 * building against unsigned remote fetch (confirmed working for this account:
 * https://res.cloudinary.com/{cloud}/image/fetch/{transforms}/{source_url}).
 *
 * Gravity/DPR deviate from the original wf-image-updaterSKILL.md spec on purpose:
 *   - bare `g_face` falls back to `north` (top-crop) when no face is detected,
 *     which is the confirmed cause of bad focal points. We use `g_face:center`
 *     (portraits) or `g_auto:subject` (general scenes) instead.
 *   - `dpr_auto` is added to every cropped transform to fix blurriness on
 *     retina/high-DPI displays -- a single fixed-pixel asset otherwise gets
 *     upscaled by the browser.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cropTable = require('../knowledge-base/image-crop-table.json').types;

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;

// Image types that need a desktop + mobile pair (two separate CMS fields).
const DUAL_FIELD_TYPES = new Set(['programs-hero', 'header-sections']);
// Image types resolved by page-template orientation (portrait vs landscape) rather
// than a fixed desktop/mobile pair.
const ORIENTATION_TYPES = new Set(['programs-home']);

function buildTransformString(spec) {
  if (!spec || spec.width == null || spec.height == null) {
    // No-crop types (e.g. blog rich text body images) -- format/quality only.
    return 'q_100,f_webp';
  }
  const gravity = spec.gravity ? `,g_${spec.gravity}` : '';
  return `w_${spec.width},h_${spec.height},c_fill${gravity},dpr_auto,q_100,f_webp`;
}

/**
 * Build a single Cloudinary fetch URL for one transform spec.
 */
function buildUrl(attachmentUrl, transformSpec) {
  if (!CLOUD_NAME) throw new Error('CLOUDINARY_CLOUD_NAME is not set.');
  const transform = buildTransformString(transformSpec);
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/${transform}/${encodeURIComponent(attachmentUrl)}`;
}

/**
 * Resolve the Cloudinary URL(s) for an image type.
 *
 * @param {string} attachmentUrl   - BugHerd attachment URL
 * @param {string} imageType       - one of the leaf keys in image-crop-table.json,
 *                                   OR 'programs-hero' / 'header-sections' (dual),
 *                                   OR 'programs-home' (needs orientation)
 * @param {object} opts
 * @param {'portrait'|'landscape'} [opts.orientation] - required for 'programs-home'
 * @param {{width:number, height:number}} [opts.helpTextDimensions] - overrides the
 *   table's width/height when the field's own helpText specifies dimensions
 *   (community/blog-thumbnail per the spec). Gravity/dpr still come from the table.
 * @returns {{ desktop?: string, mobile?: string, single?: string, noCrop?: boolean }}
 */
export function getImageUrls(attachmentUrl, imageType, opts = {}) {
  if (imageType === 'blog-rich-text') {
    return { single: buildUrl(attachmentUrl, null), noCrop: true };
  }

  if (DUAL_FIELD_TYPES.has(imageType)) {
    const desktopSpec = applyHelpText(cropTable[`${imageType}-desktop`], opts.helpTextDimensions);
    const mobileSpec = applyHelpText(cropTable[`${imageType}-mobile`], opts.helpTextDimensions);
    return {
      desktop: buildUrl(attachmentUrl, desktopSpec),
      mobile: buildUrl(attachmentUrl, mobileSpec),
    };
  }

  if (ORIENTATION_TYPES.has(imageType)) {
    if (opts.orientation !== 'portrait' && opts.orientation !== 'landscape') {
      throw new Error(`getImageUrls("${imageType}") requires opts.orientation ("portrait"|"landscape").`);
    }
    const spec = cropTable[`${imageType}-${opts.orientation}`];
    return { single: buildUrl(attachmentUrl, spec) };
  }

  const spec = applyHelpText(cropTable[imageType], opts.helpTextDimensions);
  if (!spec) throw new Error(`Unknown image type "${imageType}" -- not found in image-crop-table.json.`);
  return { single: buildUrl(attachmentUrl, spec) };
}

function applyHelpText(spec, helpTextDimensions) {
  if (!spec?.helpTextOverride || !helpTextDimensions) return spec;
  return { ...spec, width: helpTextDimensions.width, height: helpTextDimensions.height };
}

/**
 * Detect Cloudinary's silent fetch-failure mode: when the source file can't be
 * fetched (too large, blocked, access-restricted), Cloudinary returns a 200 with
 * a tiny real GIF body that Webflow then permanently caches as if it were valid.
 * Confirmed distinct from an outright 404 (which fails loudly and isn't this case).
 *
 * Detection: CDN filename ends in .gif AND desktop+mobile share the same fileId.
 * A cosmetically-named `.gif` that succeeded will have DIFFERENT fileIds.
 *
 * @param {{ url: string }} desktopField - Webflow CMS image field value after update
 * @param {{ url: string }} mobileField
 * @returns {boolean}
 */
export function isCloudinaryFetchFailure(desktopField, mobileField) {
  if (!desktopField?.url || !mobileField?.url) return false;
  const isGif = (url) => /\.gif(\?|$)/i.test(url);
  if (!isGif(desktopField.url) || !isGif(mobileField.url)) return false;

  // Webflow CDN URLs have TWO 24-char hex segments: .../{siteAssetFolderId}/{fileId}_{name}
  // -- the folder id is the SAME for every asset on the site, so matching on the first
  // 24-hex-char occurrence anywhere would always trivially match and never mean anything.
  // Anchor to the one immediately before the filename instead.
  const fileId = (url) => url.match(/\/([a-f0-9]{24})_[^/]+$/i)?.[1] ?? url;
  return fileId(desktopField.url) === fileId(mobileField.url);
}

