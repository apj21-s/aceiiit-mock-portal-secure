function createRequestQueue(options = {}) {
  const name = String(options.name || "requestQueue");
  const concurrency = Math.max(1, Number(options.concurrency || 8));
  const maxQueueSize = Math.max(concurrency, Number(options.maxQueueSize || 180));
  const maxWaitMs = Math.max(1000, Number(options.maxWaitMs || 20000));

  const queue = [];
  let activeCount = 0;
  let highWaterMark = 0;

  function logQueueEvent(level, message, extra) {
    const payload = Object.assign({ queue: name }, extra || {});
    // eslint-disable-next-line no-console
    console[level](message, payload);
  }

  function removeItem(target) {
    const index = queue.indexOf(target);
    if (index !== -1) {
      queue.splice(index, 1);
      return true;
    }
    return false;
  }

  function processQueue() {
    while (activeCount < concurrency && queue.length > 0) {
      const item = queue.shift();
      if (!item || item.cancelled) {
        continue;
      }

      const waitMs = Date.now() - item.enqueuedAt;
      if (waitMs > maxWaitMs) {
        item.cancelled = true;
        if (!item.res.headersSent) {
          item.res.status(503).json({ error: "Server busy. Please retry." });
        }
        continue;
      }

      activeCount += 1;
      item.started = true;

      let released = false;
      function release() {
        if (released) return;
        released = true;
        activeCount = Math.max(0, activeCount - 1);
        processQueue();
      }

      item.res.once("finish", release);
      item.res.once("close", release);

      try {
        item.next();
      } catch (err) {
        release();
        item.next(err);
      }
    }
  }

  function queueMiddleware(req, res, next) {
    if (activeCount < concurrency && queue.length === 0) {
      activeCount += 1;

      let released = false;
      function release() {
        if (released) return;
        released = true;
        activeCount = Math.max(0, activeCount - 1);
        processQueue();
      }

      res.once("finish", release);
      res.once("close", release);
      return next();
    }

    if (queue.length >= maxQueueSize) {
      logQueueEvent("warn", "Attempt queue full", {
        activeCount,
        queued: queue.length,
        maxQueueSize,
      });
      return res.status(503).json({ error: "Server busy. Please retry." });
    }

    const item = {
      req,
      res,
      next,
      enqueuedAt: Date.now(),
      started: false,
      cancelled: false,
    };

    queue.push(item);
    if (queue.length > highWaterMark) {
      highWaterMark = queue.length;
      if (highWaterMark === maxQueueSize || highWaterMark % 25 === 0) {
        logQueueEvent("warn", "Attempt queue backlog growing", {
          activeCount,
          queued: queue.length,
          highWaterMark,
          concurrency,
        });
      }
    }

    const waitTimer = setTimeout(() => {
      if (item.started || item.cancelled) return;
      if (removeItem(item)) {
        item.cancelled = true;
        if (!res.headersSent) {
          res.status(503).json({ error: "Server busy. Please retry." });
        }
      }
    }, maxWaitMs);

    res.once("close", () => {
      clearTimeout(waitTimer);
      if (!item.started) {
        item.cancelled = true;
        removeItem(item);
      }
    });
    res.once("finish", () => clearTimeout(waitTimer));

    return undefined;
  }

  queueMiddleware.getStats = function getStats() {
    return {
      name,
      concurrency,
      maxQueueSize,
      maxWaitMs,
      activeCount,
      queued: queue.length,
      highWaterMark,
    };
  };

  return queueMiddleware;
}

module.exports = { createRequestQueue };
