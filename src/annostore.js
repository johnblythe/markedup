// Node-side annotation store backing the local annotations API (the "stub"
// in the multiplayer contract, tmp/multiplayer-contract.md). Semantics mirror
// the ldpub Worker exactly:
//   - one JSON doc per source file: <source>.annotations.json (tombstones kept)
//   - server stamps author/createdAt/updatedAt, mirrors status -> state
//   - PUT can't rewrite replies; a tombstone refuses resurrection (410)
//   - rect PNGs live in <source>.shots/<annoId>.png, referenced via shotUrl
//
// Identity comes from the caller (serve.js resolves X-Markup-User / ?as=).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_ANNOTATION_BYTES = 64 * 1024;
const MAX_REPLY_LENGTH = 4000;

function isValidAnnotationId(id) {
  return ID_PATTERN.test(String(id));
}

function stateFor(status) {
  if (status === "accepted") return "resolved";
  if (status === "pending") return "pending";
  return "open";
}

// Result shape for handlers: { status, body } — body is JSON-serializable.
function err(status, message) {
  return { status, body: { error: message } };
}

function createAnnotationStore(sourcePath) {
  const stem = path.basename(sourcePath).replace(/\.[^.]+$/, "");
  const docPath = path.join(path.dirname(sourcePath), `${stem}.annotations.json`);
  const shotsDir = path.join(path.dirname(sourcePath), `${stem}.shots`);

  function readDoc() {
    try {
      const parsed = JSON.parse(fs.readFileSync(docPath, "utf-8"));
      if (Array.isArray(parsed.annotations)) return parsed;
    } catch (_e) {
      /* missing or malformed -> empty */
    }
    return { annotations: [] };
  }

  function writeDoc(doc) {
    fs.writeFileSync(docPath, JSON.stringify(doc, null, 2), "utf-8");
  }

  function etagOf(doc) {
    const hash = crypto.createHash("sha1").update(JSON.stringify(doc)).digest("hex");
    return `"anno-${hash.slice(0, 16)}"`;
  }

  function list(ifNoneMatch) {
    const doc = readDoc();
    const etag = etagOf(doc);
    if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, body: null, etag };
    return {
      status: 200,
      etag,
      body: { etag, annotations: doc.annotations.filter((a) => !a.deleted) },
    };
  }

  function put(id, body, author) {
    if (!isValidAnnotationId(id)) return err(400, "invalid annotation id");
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return err(400, "annotation object required");
    }
    if (body.id !== undefined && body.id !== id) return err(400, "id mismatch");
    body.id = id;

    if (body.payload && typeof body.payload === "object" && "pngDataURL" in body.payload) {
      delete body.payload.pngDataURL;
    }
    if (JSON.stringify(body).length > MAX_ANNOTATION_BYTES) {
      return err(413, "annotation too large");
    }

    const now = new Date().toISOString();
    const doc = readDoc();
    const idx = doc.annotations.findIndex((a) => a.id === id);
    const existing = idx === -1 ? null : doc.annotations[idx];
    if (existing && existing.deleted) return err(410, "annotation deleted");

    const merged = {
      ...body,
      author: (existing && existing.author) || author,
      createdAt:
        (existing && existing.createdAt) ||
        (typeof body.createdAt === "string" ? body.createdAt : now),
      updatedAt: now,
      replies: (existing && existing.replies) || [],
      state: stateFor(body.status),
    };
    delete merged.deleted;
    if (existing && existing.author && existing.author !== author) {
      merged.lastEditedBy = author;
    }

    // Contract convenience mirrors (matches the Worker): flatten the
    // overlay's nested anchor.cssPath / anchorText for API consumers.
    if (merged.cssPath === undefined && body.anchor && typeof body.anchor.cssPath === "string") {
      merged.cssPath = body.anchor.cssPath;
    }
    if (merged.anchorText === undefined) {
      const text =
        (body.anchor && body.anchor.anchorText) || (body.payload && body.payload.anchorText);
      if (typeof text === "string") merged.anchorText = text;
    }

    if (idx === -1) doc.annotations.push(merged);
    else doc.annotations[idx] = merged;
    writeDoc(doc);
    return { status: 200, body: merged };
  }

  function tombstone(id, author) {
    if (!isValidAnnotationId(id)) return err(400, "invalid annotation id");
    const doc = readDoc();
    const idx = doc.annotations.findIndex((a) => a.id === id);
    if (idx === -1) return err(404, "annotation not found");
    doc.annotations[idx] = {
      ...doc.annotations[idx],
      deleted: true,
      updatedAt: new Date().toISOString(),
      lastEditedBy: author,
    };
    writeDoc(doc);
    return { status: 200, body: { ok: true, id } };
  }

  function reply(id, body, author) {
    if (!isValidAnnotationId(id)) return err(400, "invalid annotation id");
    const text = body && typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return err(400, "text required");

    const doc = readDoc();
    const anno = doc.annotations.find((a) => a.id === id && !a.deleted);
    if (!anno) return err(404, "annotation not found");

    const record = {
      author,
      text: text.slice(0, MAX_REPLY_LENGTH),
      at: new Date().toISOString(),
      via: body.via === "slack" ? "slack" : "canvas",
    };
    anno.replies = Array.isArray(anno.replies) ? anno.replies : [];
    anno.replies.push(record);
    anno.updatedAt = record.at;
    writeDoc(doc);
    return { status: 200, body: anno };
  }

  function putShot(annoId, buf, user, project) {
    const id = String(annoId).replace(/\.png$/, "");
    if (!isValidAnnotationId(id)) return err(400, "invalid annotation id");
    if (!buf || buf.length === 0) return err(400, "empty body");
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.writeFileSync(path.join(shotsDir, `${id}.png`), buf);
    return { status: 200, body: { ok: true, shotUrl: `/api/${user}/${project}/shots/${id}.png` } };
  }

  function getShot(annoId) {
    const id = String(annoId).replace(/\.png$/, "");
    if (!isValidAnnotationId(id)) return null;
    const p = path.join(shotsDir, `${id}.png`);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  return { list, put, tombstone, reply, putShot, getShot, docPath, shotsDir };
}

module.exports = { createAnnotationStore, isValidAnnotationId, stateFor };
