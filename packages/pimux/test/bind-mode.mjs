// Preload (`--import`) for service tests: record each Unix socket's mode as
// `listen` binds it, before the service can change it. Node binds a socket path
// synchronously inside `listen`, so this is the mode a concurrent probe can see.
import fs from "node:fs";
import net from "node:net";

const record = process.env.PIMUX_TEST_BIND_MODES;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const server = listen.apply(this, args);
  if (record && typeof args[0] === "string") {
    fs.appendFileSync(record, `${JSON.stringify({ path: args[0], mode: fs.lstatSync(args[0]).mode & 0o777 })}\n`);
  }
  return server;
};
