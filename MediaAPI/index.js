const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");
const multipart = require("parse-multipart-data");

const BLOB_CONN_STR = process.env.AzureWebJobsStorage;
const COSMOS_CONN_STR = process.env.COSMOS_CONNECTION_STRING || process.env["COSMOS.CONNECTION.STRING"];
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME || "cloudmediahub";
const COSMOS_CONT_NAME = process.env.COSMOS_CONTAINER || "media";
const BLOB_CONTAINER = "media-files";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

module.exports = async function (context, req) {
  if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }
  const id = context.bindingData.id || null;
  const method = req.method.toUpperCase();
  try {
    if (method === "GET" && !id) {
      const client = new CosmosClient(COSMOS_CONN_STR);
      const { resources } = await client.database(COSMOS_DB_NAME).container(COSMOS_CONT_NAME).items.query("SELECT * FROM c ORDER BY c._ts DESC").fetchAll();
      context.res = { status: 200, headers: CORS, body: JSON.stringify(resources) };
    } else if (method === "GET" && id) {
      const client = new CosmosClient(COSMOS_CONN_STR);
      const { resource } = await client.database(COSMOS_DB_NAME).container(COSMOS_CONT_NAME).item(id, id).read();
      context.res = { status: resource ? 200 : 404, headers: CORS, body: JSON.stringify(resource || { error: "Not found" }) };
    } else if (method === "POST") {
      const boundary = (req.headers["content-type"] || "").match(/boundary=([^;]+)/)?.[1];
      const parts = multipart.parse(Buffer.from(req.rawBody), boundary);
      const filePart = parts.find(p => p.filename);
      if (!filePart) { context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: "No file" }) }; return; }
      const newId = uuidv4();
      const blobName = newId + filePart.filename.match(/(\.[^.]+)$/)?.[1] || ".bin";
      const blobService = BlobServiceClient.fromConnectionString(BLOB_CONN_STR);
      const containerClient = blobService.getContainerClient(BLOB_CONTAINER);
      await containerClient.createIfNotExists({ access: "blob" });
      const blockBlob = containerClient.getBlockBlobClient(blobName);
      await blockBlob.uploadData(filePart.data, { blobHTTPHeaders: { blobContentType: filePart.type } });
      const getField = (n) => { const p = parts.find(x => x.name === n && !x.filename); return p ? p.data.toString("utf8") : ""; };
      const doc = { id: newId, title: getField("title") || filePart.filename, description: getField("description"), category: getField("category") || "other", tags: JSON.parse(getField("tags") || "[]"), visibility: getField("visibility") || "public", uploadedBy: getField("uploadedBy"), fileName: filePart.filename, fileType: filePart.type, fileSize: filePart.data.length, blobUrl: blockBlob.url, blobName, mediaType: filePart.type?.startsWith("image") ? "image" : filePart.type?.startsWith("video") ? "video" : filePart.type?.startsWith("audio") ? "audio" : "document", uploadedAt: new Date().toISOString() };
      const client = new CosmosClient(COSMOS_CONN_STR);
      await client.database(COSMOS_DB_NAME).container(COSMOS_CONT_NAME).items.create(doc);
      context.res = { status: 201, headers: CORS, body: JSON.stringify(doc) };
    } else if (method === "PUT" && id) {
      const client = new CosmosClient(COSMOS_CONN_STR);
      const { resource: existing } = await client.database(COSMOS_DB_NAME).container(COSMOS_CONT_NAME).item(id, id).read();
      if (!existing) { context.res = { status: 404, headers: CORS, body: JSON.stringify({ error: "Not found" }) }; return; }
      const updated = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
      await client.database(COSMOS_DB_NAME).container(COSMOS_CONT_NAME).item(id, id).replace(updated);
      context.res = { status: 200, headers: CORS, body: JSON.stringify(updated) };
    } else if (method === "DELETE" && id) {
      const client = new CosmosClient(COSMOS_CONN_STR);
      const { resource } = await client.database(COSMOS_DB_NAME).container(COSMOS_CONT_NAME).item(id, id).read();
      if (!resource) { context.res = { status: 404, headers: CORS, body: JSON.stringify({ error: "Not found" }) }; return; }
      if (resource.blobName) { const b = BlobServiceClient.fromConnectionString(BLOB_CONN_STR).getContainerClient(BLOB_CONTAINER).getBlockBlobClient(resource.blobName); await b.deleteIfExists(); }
      await client.database(COSMOS_DB_NAME).container(COSMOS_CONT_NAME).item(id, id).delete();
      context.res = { status: 200, headers: CORS, body: JSON.stringify({ message: "Deleted", id }) };
    } else {
      context.res = { status: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
    }
  } catch (err) {
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
