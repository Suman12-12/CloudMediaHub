/**
 * CloudMediaHub – Azure Function REST API
 * COM682 Cloud Native Development – CW2
 * Student: Suman Thapa | B00974972
 *
 * Route: /api/media/{id?}
 * Methods: GET, POST, PUT, DELETE, OPTIONS
 *
 * Integrates:
 *   - Azure Blob Storage  (media files)
 *   - Azure Cosmos DB     (metadata documents)
 */

const { BlobServiceClient }   = require("@azure/storage-blob");
const { CosmosClient }         = require("@azure/cosmos");
const { v4: uuidv4 }           = require("uuid");
const multipart                = require("parse-multipart-data");

// ── Read environment variables (set in Azure Function App → Configuration) ──
const BLOB_CONN_STR   = process.env.AzureWebJobsStorage;
const COSMOS_CONN_STR = process.env.COSMOS_CONNECTION_STRING;
const COSMOS_DB_NAME  = process.env.COSMOS_DB_NAME   || "cloudmediahub";
const COSMOS_CONT_NAME= process.env.COSMOS_CONTAINER || "media";
const BLOB_CONTAINER  = "media-files";

// ── Shared CORS headers ─────────────────────────────────────────────────────
const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key"
};

// ── Lazy clients (created once, reused across warm invocations) ─────────────
let _cosmosContainer = null;
let _blobContainer   = null;

function getCosmosContainer() {
  if (!_cosmosContainer) {
    const client = new CosmosClient(COSMOS_CONN_STR);
    _cosmosContainer = client
      .database(COSMOS_DB_NAME)
      .container(COSMOS_CONT_NAME);
  }
  return _cosmosContainer;
}

async function getBlobContainer() {
  if (!_blobContainer) {
    const blobService = BlobServiceClient.fromConnectionString(BLOB_CONN_STR);
    _blobContainer    = blobService.getContainerClient(BLOB_CONTAINER);
    // Create the container if it doesn't exist yet
    await _blobContainer.createIfNotExists({ access: "blob" });
  }
  return _blobContainer;
}

// ════════════════════════════════════════
//  ENTRY POINT
// ════════════════════════════════════════
module.exports = async function (context, req) {
  context.log(`[CloudMediaHub] ${req.method} /api/media/${context.bindingData.id || ""}`);

  // Pre-flight (browser CORS check)
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: CORS };
    return;
  }

  const id     = context.bindingData.id || null;
  const method = req.method.toUpperCase();

  try {
    if      (method === "POST"   && !id) await handleCreate(context, req);
    else if (method === "GET"    && !id) await handleList(context, req);
    else if (method === "GET"    &&  id) await handleGetOne(context, id);
    else if (method === "PUT"    &&  id) await handleUpdate(context, req, id);
    else if (method === "DELETE" &&  id) await handleDelete(context, id);
    else {
      context.res = {
        status: 405,
        headers: CORS,
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }
  } catch (err) {
    context.log.error("[CloudMediaHub] Unhandled error:", err.message);
    context.res = {
      status: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Internal server error", detail: err.message })
    };
  }
};

// ════════════════════════════════════════
//  CREATE  –  POST /api/media
//  Parses multipart form, uploads blob, saves Cosmos doc
// ════════════════════════════════════════
async function handleCreate(context, req) {
  // Parse multipart/form-data
  const contentType = req.headers["content-type"] || "";
  const boundary    = extractBoundary(contentType);

  if (!boundary) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: "Missing multipart boundary" }) };
    return;
  }

  const parts   = multipart.parse(Buffer.from(req.rawBody), boundary);
  const filePart = parts.find(p => p.filename);

  if (!filePart) {
    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: "No file found in request" }) };
    return;
  }

  const id       = uuidv4();
  const ext      = getExt(filePart.filename);
  const blobName = `${id}${ext}`;
  const mimeType = filePart.type || "application/octet-stream";

  // 1. Upload file to Azure Blob Storage
  const blobContainer  = await getBlobContainer();
  const blockBlobClient = blobContainer.getBlockBlobClient(blobName);
  await blockBlobClient.uploadData(filePart.data, {
    blobHTTPHeaders: { blobContentType: mimeType }
  });

  // 2. Build and save metadata document to Cosmos DB
  const tagsRaw = getField(parts, "tags");
  const doc = {
    id,
    title:       getField(parts, "title")       || filePart.filename,
    description: getField(parts, "description") || "",
    category:    getField(parts, "category")    || "other",
    tags:        parseTags(tagsRaw),
    visibility:  getField(parts, "visibility")  || "public",
    uploadedBy:  getField(parts, "uploadedBy")  || "anonymous",
    fileName:    filePart.filename,
    fileType:    mimeType,
    fileSize:    filePart.data.length,
    blobName,
    blobUrl:     blockBlobClient.url,
    mediaType:   guessMediaType(mimeType),
    uploadedAt:  new Date().toISOString(),
    updatedAt:   new Date().toISOString()
  };

  await getCosmosContainer().items.create(doc);

  context.log(`[CloudMediaHub] Created media id=${id} blob=${blobName}`);
  context.res = { status: 201, headers: CORS, body: JSON.stringify(doc) };
}

// ════════════════════════════════════════
//  LIST  –  GET /api/media
//  Optional query params: ?type=image&visibility=public&search=hello
// ════════════════════════════════════════
async function handleList(context, req) {
  const { type, visibility, search } = req.query;

  let query  = "SELECT * FROM c ORDER BY c._ts DESC";
  const params = [];
  const conds  = [];

  if (type)       { conds.push("c.mediaType = @type");   params.push({ name: "@type",   value: type }); }
  if (visibility) { conds.push("c.visibility = @vis");   params.push({ name: "@vis",    value: visibility }); }
  if (search) {
    conds.push("(CONTAINS(LOWER(c.title), @search) OR ARRAY_CONTAINS(c.tags, @search))");
    params.push({ name: "@search", value: search.toLowerCase() });
  }

  if (conds.length) {
    query = `SELECT * FROM c WHERE ${conds.join(" AND ")} ORDER BY c._ts DESC`;
  }

  const { resources } = await getCosmosContainer()
    .items.query({ query, parameters: params })
    .fetchAll();

  context.res = {
    status: 200,
    headers: CORS,
    body: JSON.stringify(resources)
  };
}

// ════════════════════════════════════════
//  GET ONE  –  GET /api/media/{id}
// ════════════════════════════════════════
async function handleGetOne(context, id) {
  const { resource } = await getCosmosContainer().item(id, id).read();

  if (!resource) {
    context.res = { status: 404, headers: CORS, body: JSON.stringify({ error: "Not found" }) };
    return;
  }

  context.res = { status: 200, headers: CORS, body: JSON.stringify(resource) };
}

// ════════════════════════════════════════
//  UPDATE  –  PUT /api/media/{id}
//  Only metadata fields — does NOT re-upload the file
// ════════════════════════════════════════
async function handleUpdate(context, req, id) {
  const { resource: existing } = await getCosmosContainer().item(id, id).read();

  if (!existing) {
    context.res = { status: 404, headers: CORS, body: JSON.stringify({ error: "Not found" }) };
    return;
  }

  const body = req.body || {};

  const updated = {
    ...existing,
    title:       body.title       ?? existing.title,
    description: body.description ?? existing.description,
    category:    body.category    ?? existing.category,
    tags:        body.tags        ?? existing.tags,
    visibility:  body.visibility  ?? existing.visibility,
    updatedAt:   new Date().toISOString()
  };

  await getCosmosContainer().item(id, id).replace(updated);

  context.log(`[CloudMediaHub] Updated media id=${id}`);
  context.res = { status: 200, headers: CORS, body: JSON.stringify(updated) };
}

// ════════════════════════════════════════
//  DELETE  –  DELETE /api/media/{id}
//  Removes blob from Blob Storage AND doc from Cosmos DB
// ════════════════════════════════════════
async function handleDelete(context, id) {
  const { resource } = await getCosmosContainer().item(id, id).read();

  if (!resource) {
    context.res = { status: 404, headers: CORS, body: JSON.stringify({ error: "Not found" }) };
    return;
  }

  // Delete file from Blob Storage
  if (resource.blobName) {
    const blobContainer   = await getBlobContainer();
    const blockBlobClient  = blobContainer.getBlockBlobClient(resource.blobName);
    await blockBlobClient.deleteIfExists({ deleteSnapshots: "include" });
  }

  // Delete metadata from Cosmos DB
  await getCosmosContainer().item(id, id).delete();

  context.log(`[CloudMediaHub] Deleted media id=${id} blob=${resource.blobName}`);
  context.res = {
    status: 200,
    headers: CORS,
    body: JSON.stringify({ message: "Deleted successfully", id })
  };
}

// ════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════
function extractBoundary(contentType) {
  const m = contentType.match(/boundary=([^;]+)/);
  return m ? m[1].trim() : null;
}

function getField(parts, name) {
  const p = parts.find(x => x.name === name && !x.filename);
  return p ? p.data.toString("utf8").trim() : null;
}

function getExt(filename) {
  const m = (filename || "").match(/(\.[^.]+)$/);
  return m ? m[1].toLowerCase() : ".bin";
}

function parseTags(raw) {
  if (!raw) return [];
  try   { return JSON.parse(raw); }
  catch { return raw.split(",").map(t => t.trim()).filter(Boolean); }
}

function guessMediaType(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}
