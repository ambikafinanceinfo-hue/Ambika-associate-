export const OFFLINE_DB_NAME = 'ambika-offline-leads-db';
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_STORE_NAME = 'lead_queue';
export const LEAD_SYNC_TAG = 'ambika-lead-sync';
export const OFFLINE_QUEUE_EVENT = 'ambika-offline-queue-updated';

export interface OfflinePendingDoc {
  category: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

export interface QueuedLeadItem {
  queueId: string;
  endpoint: '/api/leads' | '/api/public/referral-lead';
  payload: Record<string, any>;
  pendingDocs?: OfflinePendingDoc[];
  authToken?: string | null;
  customerName: string;
  loanProduct: string;
  loanAmount: number;
  bankNbfc: string;
  status: 'PENDING' | 'SYNCING' | 'FAILED';
  lastError?: string | null;
  createdAt: string;
}

export interface SyncOutcome {
  queueId: string;
  customerName: string;
  ok: boolean;
  duplicateDetected?: boolean;
  leadCode?: string;
  requestCode?: string;
  existingLeadCode?: string;
  matchedFields?: string[];
  error?: string;
}

function openOfflineDb(): Promise<IDBDatabase> {
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

export function notifyQueueUpdated() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OFFLINE_QUEUE_EVENT));
  }
}

export async function triggerBackgroundSyncRegistration(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };
    if (reg.sync && typeof reg.sync.register === 'function') {
      await reg.sync.register(LEAD_SYNC_TAG);
    }
  } catch {
    // Background Sync API not supported in Safari/Firefox; online listener handles auto-sync
  }
}

export async function getQueuedLeads(): Promise<QueuedLeadItem[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE_NAME, 'readonly');
    const store = tx.objectStore(OFFLINE_STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const rows = (req.result || []) as QueuedLeadItem[];
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueOfflineLead(
  entry: Omit<QueuedLeadItem, 'queueId' | 'status' | 'createdAt'> & { queueId?: string }
): Promise<QueuedLeadItem> {
  const item: QueuedLeadItem = {
    ...entry,
    queueId: entry.queueId || `OFFLINE-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    status: 'PENDING',
    lastError: null,
    createdAt: new Date().toISOString(),
  };

  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
    tx.objectStore(OFFLINE_STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await triggerBackgroundSyncRegistration();
  notifyQueueUpdated();
  return item;
}

export async function attachDocsToQueuedLead(queueId: string, docs: OfflinePendingDoc[]): Promise<void> {
  if (!docs.length || typeof indexedDB === 'undefined') return;
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_STORE_NAME);
    const getReq = store.get(queueId);
    getReq.onsuccess = () => {
      const existing = getReq.result as QueuedLeadItem | undefined;
      if (existing) {
        existing.pendingDocs = [...(existing.pendingDocs || []), ...docs];
        store.put(existing);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifyQueueUpdated();
}

export async function removeQueuedLead(queueId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
    tx.objectStore(OFFLINE_STORE_NAME).delete(queueId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifyQueueUpdated();
}

async function putQueuedLead(item: QueuedLeadItem): Promise<void> {
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
    tx.objectStore(OFFLINE_STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let activeFlushPromise: Promise<SyncOutcome[]> | null = null;

async function flushQueueDirectly(fallbackToken?: string | null): Promise<SyncOutcome[]> {
  const queue = await getQueuedLeads();
  if (queue.length === 0) return [];
  if (typeof navigator !== 'undefined' && !navigator.onLine) return [];

  const outcomes: SyncOutcome[] = [];
  for (const item of queue) {
    if (item.status === 'SYNCING') continue;
    try {
      await putQueuedLead({ ...item, status: 'SYNCING', lastError: null });
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
          await removeQueuedLead(item.queueId);
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
          if (data.lead?.id && item.pendingDocs && item.pendingDocs.length > 0 && token) {
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
          await removeQueuedLead(item.queueId);
          outcomes.push({
            queueId: item.queueId,
            customerName: item.customerName,
            ok: true,
            leadCode: data.lead?.leadCode || data.leadCode,
          });
        }
      } else {
        const errMsg = data?.error || `Sync rejected (${resp.status})`;
        await putQueuedLead({ ...item, status: 'FAILED', lastError: errMsg });
        outcomes.push({
          queueId: item.queueId,
          customerName: item.customerName,
          ok: false,
          error: errMsg,
        });
      }
    } catch (err: any) {
      await putQueuedLead({
        ...item,
        status: 'PENDING',
        lastError: err?.message || 'Network unavailable',
      });
    }
  }
  notifyQueueUpdated();
  return outcomes;
}

export async function syncOfflineLeadQueue(currentToken?: string | null): Promise<SyncOutcome[]> {
  if (activeFlushPromise) return activeFlushPromise;

  activeFlushPromise = (async () => {
    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return [];
      const existing = await getQueuedLeads();
      if (existing.length === 0) return [];

      // Prefer delegating to controlling Service Worker so SW Background Sync + client stay unified
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
        try {
          const swResults = await new Promise<SyncOutcome[] | null>((resolve) => {
            const channel = new MessageChannel();
            const timer = window.setTimeout(() => resolve(null), 4500);
            channel.port1.onmessage = (event) => {
              window.clearTimeout(timer);
              resolve(event.data?.outcomes ?? null);
            };
            navigator.serviceWorker.controller!.postMessage(
              { type: 'SYNC_QUEUED_LEADS', authToken: currentToken ?? null },
              [channel.port2]
            );
          });
          if (swResults !== null) {
            notifyQueueUpdated();
            return swResults;
          }
        } catch {
          // fallback to direct flush
        }
      }

      return await flushQueueDirectly(currentToken);
    } finally {
      activeFlushPromise = null;
    }
  })();

  return activeFlushPromise;
}
