/**
 * Native messaging ports are long-lived service-worker connections. The old
 * implementation kept a second offscreen heartbeat for Record/Replay; the
 * browser-only bridge does not need that extra lifecycle or document.
 */
