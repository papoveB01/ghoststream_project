// Cloudflare R2 client (S3-compatible) for Knowledge Base file storage.
//
// We store the ORIGINAL upload (the raw PDF/MD/txt) so admins can always
// re-download what was actually uploaded. The parsed text + chunks live in
// Postgres; R2 is the durable archive.
//
// Object key convention: `knowledge/{category}/{documentId}/{safeFilename}`.

const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } =
  require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.R2_BUCKET || '';
const ENDPOINT = process.env.R2_ENDPOINT || '';
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';

let _client;

function isConfigured() {
  return Boolean(BUCKET && ENDPOINT && ACCESS_KEY && SECRET_KEY);
}

function getClient() {
  if (_client) return _client;
  if (!isConfigured()) {
    const err = new Error('R2 storage not configured (set R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
    err.status = 500;
    throw err;
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    },
    forcePathStyle: false,
  });
  return _client;
}

function safeFilename(name) {
  return String(name || 'upload')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 200) || 'upload';
}

function buildKey({ category, documentId, filename }) {
  return `knowledge/${category}/${documentId}/${safeFilename(filename)}`;
}

async function putObject({ key, body, contentType }) {
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

async function deleteObject(key) {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// List all object keys under a prefix (paginated). Used by tenant erasure to
// sweep `recordings/<botId>/` objects, which aren't referenced from Postgres.
async function listObjects(prefix) {
  const client = getClient();
  const keys = [];
  let token;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of out.Contents || []) keys.push(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function presignGet(key, ttlSec = 300) {
  const client = getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: ttlSec }
  );
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = {
  isConfigured,
  buildKey,
  putObject,
  deleteObject,
  listObjects,
  presignGet,
  sha256,
  safeFilename,
};
