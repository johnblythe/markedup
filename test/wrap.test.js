const { test } = require("node:test");
const assert = require("node:assert");
const { wrapHTML, WRAP_MARKER } = require("../src/wrap");

const BASIC_HTML = `<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>`;

test("wrapHTML injects style and script", () => {
  const out = wrapHTML(BASIC_HTML, { key: "/foo", sourceName: "foo.html", styles: ".markup-x{}" });
  assert.match(out, /<style id="markup-overlay-styles"/);
  assert.match(out, /<script id="markup-bootstrap"/);
  assert.match(out, /__MARKUP_KEY__/);
  assert.match(out, /\/__markup\/client\.js/);
  assert.match(out, /\/__markup\/modern-screenshot\.js/);
});

test("wrapHTML is idempotent: re-wrapping returns unchanged string", () => {
  const once = wrapHTML(BASIC_HTML, { key: "/foo", sourceName: "foo.html", styles: ".x{}" });
  const twice = wrapHTML(once, { key: "/foo", sourceName: "foo.html", styles: ".x{}" });
  assert.strictEqual(once, twice);
});

test("wrapHTML places style before </head>", () => {
  const out = wrapHTML(BASIC_HTML, { key: "/k", sourceName: "n.html", styles: ".x{}" });
  const styleIdx = out.indexOf('<style id="markup-overlay-styles"');
  const headCloseIdx = out.indexOf("</head>");
  assert.ok(styleIdx > -1 && headCloseIdx > -1);
  assert.ok(styleIdx < headCloseIdx, "style should be before </head>");
});

test("wrapHTML places bootstrap before </body>", () => {
  const out = wrapHTML(BASIC_HTML, { key: "/k", sourceName: "n.html", styles: ".x{}" });
  const scriptIdx = out.indexOf('<script id="markup-bootstrap"');
  const bodyCloseIdx = out.indexOf("</body>");
  assert.ok(scriptIdx > -1 && bodyCloseIdx > -1);
  assert.ok(scriptIdx < bodyCloseIdx, "script should be before </body>");
});

test("wrapHTML handles HTML with no <head>", () => {
  const html = "<html><body><p>x</p></body></html>";
  const out = wrapHTML(html, { key: "/k", sourceName: "n.html", styles: ".x{}" });
  assert.match(out, /<style id="markup-overlay-styles"/);
});

test("wrapHTML handles HTML with no <body>", () => {
  const html = "<p>just a fragment</p>";
  const out = wrapHTML(html, { key: "/k", sourceName: "n.html", styles: ".x{}" });
  assert.match(out, /<script id="markup-bootstrap"/);
});

test("wrapHTML embeds key as a JSON-quoted string", () => {
  const out = wrapHTML(BASIC_HTML, {
    key: '/path/with "quotes".html',
    sourceName: "x.html",
    styles: "",
  });
  // Embedded value should be JSON-stringified so embedded quotes don't break the script.
  assert.match(out, /__MARKUP_KEY__ = "\/path\/with \\"quotes\\"\.html"/);
});

test("WRAP_MARKER attribute is on injected style and script", () => {
  const out = wrapHTML(BASIC_HTML, { key: "/k", sourceName: "n.html", styles: ".x{}" });
  assert.match(out, new RegExp(`<style id="markup-overlay-styles" ${WRAP_MARKER}="true"`));
  assert.match(out, new RegExp(`<script id="markup-bootstrap" ${WRAP_MARKER}="true"`));
});
