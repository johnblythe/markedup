// Idempotent HTML wrapper. Injects:
//   - <style> with overlay stylesheet (inline)
//   - <script> with markup key + bootstrap config (inline)
//   - <script src="/__markup/modern-screenshot.js"> (external, served by node)
//   - <script src="/__markup/client.js"> (external, served by node)
//
// Source HTML is never modified on disk — wrapHTML returns a new string.

const WRAP_MARKER = "data-markup-wrapped";

// Find a sensible insertion point for a tag. Returns { index, position } where
// position is "before" or "after" the matched index.
function findInsertion(html, tag) {
  const lower = html.toLowerCase();
  // Try the closing tag first: insert content before </tag>
  const close = lower.indexOf(`</${tag}>`);
  if (close !== -1) return { index: close, position: "before" };
  // Try the opening tag: insert content after <tag ...>
  const open = lower.indexOf(`<${tag}`);
  if (open !== -1) {
    const gt = lower.indexOf(">", open);
    if (gt !== -1) return { index: gt + 1, position: "after" };
  }
  return null;
}

function insertAt(html, insertion, snippet) {
  if (!insertion) return snippet + html;
  return html.slice(0, insertion.index) + snippet + html.slice(insertion.index);
}

function escapeHTML(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// `opts` may contain:
//   key:        absolute source path, exposed as window.__MARKUP_KEY__
//   sourceName: basename, exposed as window.__MARKUP_SOURCE_NAME__
//   styles:     inline CSS string (overlay styles)
function wrapHTML(rawHTML, opts = {}) {
  // Idempotent: if already wrapped, return unchanged.
  if (rawHTML.includes(`${WRAP_MARKER}="true"`)) {
    return rawHTML;
  }

  const key = opts.key || "";
  const sourceName = opts.sourceName || "";
  const styles = opts.styles || "";

  let result = rawHTML;

  // Tag the tab title with "markedup" so a served artifact is findable via
  // Chrome's tab search (Cmd+Shift+A) instead of hunting for its port
  // number. Append to an existing <title> so the artifact's own title stays
  // visible; fall back to a fresh one if the source has none.
  const titleInsertion = findInsertion(result, "title");
  if (titleInsertion) {
    result = insertAt(result, titleInsertion, " — markedup");
  } else {
    const label = sourceName ? `markedup — ${sourceName}` : "markedup";
    result = insertAt(result, findInsertion(result, "head"), `<title>${escapeHTML(label)}</title>\n`);
  }

  // Style block goes near the top of <head> (or prepended to the doc).
  const styleBlock =
    `\n<style id="markup-overlay-styles" ${WRAP_MARKER}="true">\n${styles}\n</style>\n`;

  // Bootstrap script + external client scripts go near </body>.
  // The marker attribute on the bootstrap script is what re-wrap detection looks for.
  const sourceHash = opts.sourceHash || "";
  const bootstrap =
    `\n<script id="markup-bootstrap" ${WRAP_MARKER}="true">\n` +
    `  window.__MARKUP_KEY__ = ${JSON.stringify(key)};\n` +
    `  window.__MARKUP_SOURCE_NAME__ = ${JSON.stringify(sourceName)};\n` +
    `  window.__MARKUP_SOURCE_HASH__ = ${JSON.stringify(sourceHash)};\n` +
    `</script>\n` +
    `<script src="/__markup/modern-screenshot.js"></script>\n` +
    `<script src="/__markup/client.js"></script>\n`;

  // Recompute the head insertion point against the (possibly title-mutated) result.
  const headInsertion = findInsertion(result, "head");
  if (headInsertion) {
    result = insertAt(result, headInsertion, styleBlock);
  } else {
    // No <head> — prepend.
    result = styleBlock + result;
  }

  // Recompute body insertion against the now-mutated string.
  const bodyInsertion = findInsertion(result, "body");
  if (bodyInsertion) {
    result = insertAt(result, bodyInsertion, bootstrap);
  } else {
    result = result + bootstrap;
  }

  return result;
}

module.exports = { wrapHTML, WRAP_MARKER };
