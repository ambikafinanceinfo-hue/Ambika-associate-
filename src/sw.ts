import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

const OFFLINE_DB_NAME = 'ambika-offline-leads-db';
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE_NAME = 'lead_queue';
const LEAD_SYNC_TAG = 'ambika-lead-sync';

interface SwGlobal {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
  skipWaiting: () => Promise<void>;
  registration: ServiceWorkerRegistration & {
    sync?: { register: (tag: string) => Promise<void> };
  };
  clients: {
    matchAll: (options?: { type?: string; includeUncontrolled?: boolean }) => Promise<Array<{ postMessage: (msg: any) => void }>>;
  };
  addEventListener: (type: string, listener: (event: any) => void) => void;
}

const sw = self as unknown as SwGlobal;

sw.skipWaiting();
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute((self as unknown as SwGlobal).__WB_MANIFEST || []);

// SPA navigation fallback (ignore /api/* routes)
try {
  registerRoute(
    new NavigationRoute(createHandlerBoundToURL('index.html'), {
      denylist: [/^\/api\//],
    })
  );
} catch {
  // Dev mode where index.html is not precached falls back cleanly to network
}

// Cache read-only API GETs (leads list, field officer directory, branding) for offline field viewing
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' &&
    (/^\/api\/(leads|directory|public\/branding)/.test(url.pathname)),
  new NetworkFirst({
    cacheName: 'ambika-api-read-cache',
    networkTimeoutSeconds: 4,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 }),
    ],
  })
);

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
        db.createObjectStore(OFFLINE_STORE_NAME, { keyPath: 'queueId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(): Promise<any[]> {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE_NAME, 'readonly');
    const req = tx.objectStore(OFFLINE_STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(item: any): Promise<void> {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
    tx.objectStore(OFFLINE_STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(queueId: string): Promise<void> {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
    tx.objectStore(OFFLINE_STORE_NAME).delete(queueId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function broadcastToClients(message: any) {
  const clientList = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    client.postMessage(message);
  }
}

let swSyncInFlight: Promise<any[]> | null = null;

async function flushOfflineLeadsInSw(fallbackToken?: string | null): Promise<any[]> {
  if (swSyncInFlight) return swSyncInFlight;
  swSyncInFlight = (async () => {
    try {
      const rows = await idbGetAll();
      rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const outcomes: any[] = [];

      for (const item of rows) {
        if (item.status === 'SYNCING') continue;
        try {
          await idbPut({ ...item, status: 'SYNCING', lastError: null });
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          const token = item.authToken || fallbackToken;
          if (item.endpoint === '/api/leads' && token) {
            headers['Authorization'] = `Bearer ${token}`;
          }

          const resp = await fetch(item.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(item.payload),
          });
          const data = await resp.json().catch(() => ({}));

          if (resp.ok) {
            if (data.duplicateDetected) {
              await idbDelete(item.queueId);
              outcomes.push({
                queueId: item.queueId,
                customerName: item.customerName,
                ok: true,
                duplicateDetected: true,
                requestCode: data.requestCode,
                existingLeadCode: data.existingLeadCode,
                matchedFields: data.matchedFields,
              });
            } else {
              if (data.lead?.id && Array.isArray(item.pendingDocs) && item.pendingDocs.length > 0 && token) {
                for (const doc of item.pendingDocs) {
                  await fetch(`/api/leads/${data.lead.id}/documents`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(doc),
                  }).catch(() => {});
                }
              }
              await idbDelete(item.queueId);
              outcomes.push({
                queueId: item.queueId,
                customerName: item.customerName,
                ok: true,
                leadCode: data.lead?.leadCode || data.leadCode,
              });
            }
          } else {
            const errMsg = data?.error || `Server returned ${resp.status}`;
            await idbPut({ ...item, status: 'FAILED', lastError: errMsg });
            outcomes.push({
              queueId: item.queueId,
              customerName: item.customerName,
              ok: false,
              error: errMsg,
            });
          }
        } catch (err: any) {
          await idbPut({
            ...item,
            status: 'PENDING',
            lastError: err?.message || 'Offline during sync retry',
          });
          throw err; // Keep remaining items queued for next Background Sync retry
        }
      }

      if (outcomes.length > 0) {
        await broadcastToClients({ type: 'OFFLINE_LEADS_SYNCED', outcomes });
      }
      return outcomes;
    } finally {
      swSyncInFlight = null;
    }
  })();
  return swSyncInFlight;
}

// Intercept POST /api/leads and POST /api/public/referral-lead when offline -> queue in IndexedDB
sw.addEventListener('fetch', (event: any) => {
  const req: Request = event.request;
  if (req.method !== 'POST') return;
  const url = new URL(req.url);
  if (url.pathname !== '/api/leads' && url.pathname !== '/api/public/referral-lead') return;

  event.respondWith(
    (async () => {
      const cloned = req.clone();
      try {
        return await fetch(req);
      } catch {
        const rawText = await cloned.text().catch(() => '{}');
        let payload: Record<string, any> = {};
        try {
          payload = rawText ? JSON.parse(rawText) : {};
        } catch {
          payload = {};
        }

        const authHeader = cloned.headers.get('Authorization') || '';
        const authToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
        const queueId = `OFFLINE-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

        const entry = {
          queueId,
          endpoint: url.pathname as '/api/leads' | '/api/public/referral-lead',
          payload,
          pendingDocs: [],
          authToken,
          customerName: String(payload.customerName || 'Offline Customer'),
          loanProduct: String(payload.loanProduct || 'Loan'),
          loanAmount: Number(payload.loanAmount || 0),
          bankNbfc: String(payload.bankNbfc || 'Partner Bank'),
          status: 'PENDING',
          lastError: null,
          createdAt: new Date().toISOString(),
        };

        await idbPut(entry);
        if (sw.registration?.sync && typeof sw.registration.sync.register === 'function') {
          await sw.registration.sync.register(LEAD_SYNC_TAG).catch(() => {});
        }
        await broadcastToClients({ type: 'LEAD_QUEUED_OFFLINE', entry });

        return new Response(
          JSON.stringify({
            queuedOffline: true,
            queueId,
            message: 'Lead saved offline in device storage. It will automatically sync when internet returns.',
          }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    })()
  );
});

// Background Sync listener: fires automatically when internet is restored (even if tab was closed)
sw.addEventListener('sync', (event: any) => {
  if (event.tag === LEAD_SYNC_TAG) {
    event.waitUntil(flushOfflineLeadsInSw());
  }
});

// Client message listener: flush queue immediately when app requests sync upon coming online
sw.addEventListener('message', (event: any) => {
  const data = event.data;
  if (!data || data.type !== 'SYNC_QUEUED_LEADS') return;
  const replyPort = event.ports?.[0];
  event.waitUntil(
    flushOfflineLeadsInSw(data.authToken ?? null)
      .then((outcomes) => {
        replyPort?.postMessage({ outcomes });
      })
      .catch((err) => {
        replyPort?.postMessage({ outcomes: [], error: err?.message || 'Sync error' });
      })
  );
});
