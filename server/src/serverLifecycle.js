// Start the HTTP server and own what happens when starting fails.
//
// Kept apart from index.js so the behavior is injectable (logger, exit), in
// line with the rest of the server's DI convention.

/**
 * @param {{
 *   app: { listen: Function },
 *   port: number,
 *   host: string,
 *   onListening?: (server: import("node:http").Server) => void,
 *   logger?: { log: Function, error: Function },
 *   exit?: (code: number) => void,
 * }} options
 */
export function startServer({
  app,
  port,
  host,
  onListening = () => {},
  logger = console,
  exit = (code) => process.exit(code),
}) {
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

    exit(1);
  });

  return { server };
}
