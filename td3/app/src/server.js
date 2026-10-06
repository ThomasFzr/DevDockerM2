import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import pg from 'pg';
import { createClient } from 'redis';

const config = {
  port: process.env.PORT ?? 3000,
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD_FILE
      ? fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim()
      : process.env.DB_PASSWORD,
  },
  redisUrl: process.env.REDIS_URL,
};

const pool = new pg.Pool(config.db);
const redis = createClient({ url: config.redisUrl });
redis.on('error', (err) => console.error('Redis error:', err.message));

async function init() {
  console.log(`Connecting to Postgres at ${config.db.host}:${config.db.port}…`);
  await pool.query(`CREATE TABLE IF NOT EXISTS visits (
    id SERIAL PRIMARY KEY,
    served_by VARCHAR(100) NOT NULL,
    at TIMESTAMP NOT NULL DEFAULT now()
  )`);
  console.log(`Connecting to Redis at ${config.redisUrl}…`);
  await redis.connect();
}

const app = express();

app.get('/', async (req, res) => {
  const hits = await redis.incr('hits');
  await pool.query('INSERT INTO visits (served_by) VALUES ($1)', [os.hostname()]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM visits');
  console.log(`GET / — hit #${hits}`);
  res.json({ hitsInRedis: hits, visitsInPostgres: rows[0].n, servedBy: os.hostname() });
});

app.get('/health', (req, res) => res.json({ status: 'UP' }));

await init();
const server = app.listen(config.port, () => console.log(`Visites API listening on ${config.port}`));

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down');
  server.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
});
