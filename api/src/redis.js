const Redis = require('ioredis');

const client = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: false,
  maxRetriesPerRequest: 3,
});

client.on('error', (err) => console.error('[redis]', err.message));

module.exports = client;
