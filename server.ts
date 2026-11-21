import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './server/db.ts';
import { createApiRouter } from './server/routes.ts';
import {
  renderAccountDeletionHtml,
  renderPrivacyPolicyHtml,
  renderTermsHtml,
} from './server/legalPages.ts';
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

  // Google Play Console required public legal pages (HTTP 200 standalone HTML)
  app.get('/privacy-policy', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPrivacyPolicyHtml());
  });
  app.get('/terms-and-conditions', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderTermsHtml());
  });
  app.get('/account-deletion', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderAccountDeletionHtml());
  });

  // Google Play Android App Links / Digital Asset Links verification
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const defaultFingerprint =
      '8D:96:F2:F8:5F:0C:A3:D6:A0:C8:4B:2A:46:F7:09:A7:75:4E:BD:8C:5E:44:B2:51:70:18:14:84:BF:7F:99:E6';
    const fingerprints = String(process.env.ANDROID_SHA256_CERT_FINGERPRINTS || defaultFingerprint)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.json([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'in.ambikaassociate.crm',
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ]);
  });

  // Prevent stale caching of PWA shell, Service Worker, Manifest, APIs & Official Logo icons
  app.use((req, res, next) => {
    const p = req.path;
    if (
      p === '/' ||
      p === '/index.html' ||
      p === '/sw.js' ||
      p === '/registerSW.js' ||
      p === '/manifest.webmanifest' ||
      p.startsWith('/api/')
    ) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (
      /^\/(pwa-|apple-touch-icon|ambika-logo|icon\.svg|assets\/aistudio\/|ambika-associate-crm\.apk)/.test(p)
    ) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    next();
  });

  app.use('/api', createApiRouter());

  if (process.env.NODE_ENV !== 'production') {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : { server: httpServer },
        watch: hmrDisabled ? null : undefined,
      },
      appType: 'spa',
    });

    // Guard Vite 8 @vite/client against WebSocket errors when HMR is disabled/closed
    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (!result?.code) {
          next();
          return;
        }
        let safeCode = result.code
          .replace(
            /ws\.send\(JSON\.stringify\(data\)\)/g,
            'if (ws && ws.readyState === 1) ws.send(JSON.stringify(data))'
          )
          .replace(/wsTransport\.send\(data\)/g, 'wsTransport?.send(data)');

        if (hmrDisabled) {
          safeCode = safeCode.replace(
            /const transport = normalizeModuleRunnerTransport\(\(\(\) => \{[\s\S]*?\}\)\(\)\);/,
            'const transport = normalizeModuleRunnerTransport({ async connect() {}, async disconnect() {}, send() {} });'
          );
        }

        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(safeCode);
      } catch {
        next();
      }
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(
      express.static(distPath, {
        etag: true,
        setHeaders(res, filePath) {
          if (
            filePath.endsWith('.html') ||
            filePath.endsWith('sw.js') ||
            filePath.endsWith('registerSW.js') ||
            filePath.endsWith('.webmanifest') ||
            /ambika-logo|pwa-|apple-touch-icon|icon\.svg|LOGO_AMBIKA/i.test(filePath)
          ) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
