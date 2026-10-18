// Start the HTTP server and own its lifecycle: what happens when starting
// fails, and how it stops.
//
// Kept apart from index.js so the behavior is injectable (logger, exit, the
// process to listen on, the database close), in line with the rest of the
// server's DI convention.

// SIGINT is Ctrl+C. SIGTERM is a service manager or `kill`. SIGHUP is what
// Node raises on Windows when the console window is closed; Windows kills the
// process a few seconds later, so shutdown must finish quickly.
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * @param {{
 *   app: { listen: Function },
 *   port: number,
 *   host: string,
 *   onListening?: (server: import("node:http").Server) => void,
 *   closeDatabase?: () => void,
 *   processRef?: { on: Function },
 *   logger?: { log: Function, error: Function },
 *   exit?: (code: number) => void,
 *   forceCloseAfterMs?: number,
 * }} options
 */
export function startServer({
  app,
  port,
  host,
  onListening = () => {},
  closeDatabase = () => {},
  processRef = process,
  logger = console,
  exit = (code) => process.exit(code),
  forceCloseAfterMs = 3000,
}) {
  const closeDatabaseSafely = () => {
    try {
      closeDatabase();
      return true;
    } catch (error) {
      logger.error(
        `Could not close the database cleanly: ${error.message}. Recent changes are ` +
          "still in its -wal file: keep that file next to the .db file."
      );
      return false;
    }
  };

  /** @type {import("node:http").Server} */
  const server = app.listen(port, host, (error) => {
    // Express 5 also calls this callback with a listen error, which the
    // "error" listener below reports. Without this check a port that is
    // already taken printed "Server running" and then exited 0.
    if (!error) {
      onListening(server);
    }
  });

  server.on("error", (error) => {
    if (server.listening) {
      logger.error(`Server error: ${error.message}`);
      return;
    }

    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EADDRINUSE") {
      logger.error(
        `Port ${port} on ${host} is already in use, so the server cannot start. ` +
          "Another copy of the app (perhaps from another folder or worktree) or another " +
          "program is using it. Stop that, or set PORT in server/.env to a free port."
      );
    } else {
      logger.error(`The server could not start: ${error.message}`);
    }

    closeDatabaseSafely();
    exit(1);
  });

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      // A second Ctrl+C means "now": skip waiting for open connections, but
      // still checkpoint and close the database.
      logger.log(`${signal} received again: exiting now.`);
      exit(closeDatabaseSafely() ? 0 : 1);
      return;
    }

    shuttingDown = true;
    logger.log(`${signal} received: stopping the server and closing the database ...`);

    // Connections still open after the grace period (a streaming planner
    // run, say) are cut so the database closes before the process is killed.
    const forceTimer = setTimeout(() => server.closeAllConnections(), forceCloseAfterMs);
    forceTimer.unref();

    server.close(() => {
      clearTimeout(forceTimer);
      exit(closeDatabaseSafely() ? 0 : 1);
    });
    server.closeIdleConnections();
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    processRef.on(signal, () => shutdown(signal));
  }

  return { server, shutdown };
}
