import express, { type Request, type Response } from 'express';
import os from 'node:os';

const port = process.env.PORT ?? 3000;
const app = express();

app.get('/', (_req: Request, res: Response) => {
  res.json({
    message: process.env.MESSAGE ?? 'Hello Docker',
    version: process.env.APP_VERSION ?? 'dev',
    hostname: os.hostname(),
  });
});

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'UP' }));

const server = app.listen(port, () => console.log(`API listening on ${port}`));

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
