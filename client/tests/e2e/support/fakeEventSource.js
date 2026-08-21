const METRICS_STORAGE_KEY = '__e2eEventSourceMetrics__';

const installFakeEventSource = async (page) => {
  await page.addInitScript((storageKey) => {
    const readMetrics = () => {
      try {
        return JSON.parse(window.sessionStorage.getItem(storageKey) || '{}');
      } catch (error) {
        return {};
      }
    };

    const persisted = readMetrics();
    const metrics = {
      created: Number.isFinite(persisted.created) ? persisted.created : 0,
      closed: Number.isFinite(persisted.closed) ? persisted.closed : 0,
    };
    const instances = [];

    const persistMetrics = () => {
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(metrics));
      } catch (error) {
        // ignore storage errors in test harnesses
      }
    };

    class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.onopen = null;
        this.onerror = null;
        this.readyState = 0;
        this.closed = false;

        instances.push(this);
        metrics.created += 1;
        persistMetrics();
      }

      addEventListener(name, handler) {
        const handlers = this.listeners.get(name) || [];
        handlers.push(handler);
        this.listeners.set(name, handlers);
      }

      removeEventListener(name, handler) {
        const handlers = this.listeners.get(name) || [];
        this.listeners.set(name, handlers.filter((candidate) => candidate !== handler));
      }

      close() {
        if (this.closed) {
          return;
        }

        this.closed = true;
        this.readyState = 2;
        metrics.closed += 1;
        persistMetrics();
      }

      _open() {
        if (this.closed) {
          return;
        }

        this.readyState = 1;
        this.onopen?.();
      }

      _error() {
        if (this.closed) {
          return;
        }

        this.readyState = 0;
        this.onerror?.(new Event('error'));
      }

      _emit(name, payload) {
        if (this.closed) {
          return;
        }

        const message = { data: JSON.stringify(payload) };
        for (const handler of this.listeners.get(name) || []) {
          handler(message);
        }
      }
    }

    const closeAll = () => {
      instances.forEach((instance) => instance.close());
    };

    window.addEventListener('beforeunload', closeAll);
    window.addEventListener('pagehide', closeAll);

    window.EventSource = FakeEventSource;
    window.__e2eLiveFeed = {
      openAll() {
        instances.forEach((instance) => instance._open());
      },
      emitSnapshot(snapshot) {
        instances.forEach((instance) => instance._emit('snapshot', snapshot));
      },
      emitError() {
        instances.forEach((instance) => instance._error());
      },
      getMetrics() {
        return {
          created: metrics.created,
          closed: metrics.closed,
          open: instances.filter((instance) => !instance.closed && instance.readyState === 1).length,
          ready: instances.filter((instance) => (
            !instance.closed
            && typeof instance.onopen === 'function'
            && typeof instance.onerror === 'function'
            && (instance.listeners.get('snapshot') || []).length > 0
          )).length,
          totalInstancesOnPage: instances.length,
        };
      },
    };
  }, METRICS_STORAGE_KEY);

  return {
    waitForSource: () => page.waitForFunction(() => (
      window.__e2eLiveFeed?.getMetrics().ready > 0
    )),
    openAll: () => page.evaluate(() => {
      window.__e2eLiveFeed.openAll();
    }),
    emitSnapshot: (snapshot) => page.evaluate((payload) => {
      window.__e2eLiveFeed.emitSnapshot(payload);
    }, snapshot),
    emitError: () => page.evaluate(() => {
      window.__e2eLiveFeed.emitError();
    }),
    getMetrics: () => page.evaluate(() => window.__e2eLiveFeed.getMetrics()),
  };
};

module.exports = {
  installFakeEventSource,
};
