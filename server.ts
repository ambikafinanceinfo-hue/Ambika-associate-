import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './server/db.ts';
import { createApiRouter } from './server/routes.ts';
import { processSlaTimers } from './server/slaEngine.ts';

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  initDatabase();
  processSlaTimers();

  // Automated SLA Timer & Penalty Engine (runs every 15 seconds)
  setInterval(() => {
    try {
      processSlaTimers();
    } catch (err) {
      console.error('SLA timer tick error:', err);
    }
  }, 15000);

  const app = express();
  const httpServer = http.createServer(app);

  app.use('/api', createApiRouter());

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server: httpServer,
        },
        watch: process.env.DISABLE_HMR === 'true' ? null : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`AMBIKA ASSOCIATE CRM running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
