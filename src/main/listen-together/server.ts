import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ListenCommand, ListenPlayback, ListenSnapshot, validateListenCommand } from "../../shared/listen-together";

const secret = () => randomBytes(32).toString("hex");
const equal = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createListenServer(options: { name: string; getPlayback: () => ListenPlayback; command: (command: ListenCommand) => Promise<void> }) {
  const app = Fastify({ bodyLimit: 4096, requestTimeout: 10000, connectionTimeout: 10000 });
  await app.register(rateLimit, { max: 1800, timeWindow: 60000 });
  const inviteToken = secret();
  const members = new Map<string, { id: string; name: string; seen: number }>();
  let allowControls = false;
  let commands = Promise.resolve();
  let pendingCommands = 0;
  let stopped = false;
  app.addHook("preClose", async () => {
    stopped = true;
    members.clear();
  });
  const expire = () => {
    for (const [token, member] of members) if (Date.now() - member.seen > 30000) members.delete(token);
  };
  const snapshot = (): ListenSnapshot => {
    expire();
    return {
      playback: options.getPlayback(),
      members: [{ id: "host", name: options.name }, ...[...members.values()].map(({ id, name }) => ({ id, name }))],
      allowControls
    };
  };
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 400;
    reply.code(status).send({ error: status >= 500 ? "Session command failed." : (error as Error).message });
  });
  app.post<{ Body: { name: string } }>("/listen/join", { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!equal(token, inviteToken)) return reply.code(401).send({ error: "Invalid invite or the session has ended." });
    expire();
    if (members.size >= 20) return reply.code(409).send({ error: "This session is full (20 guests)." });
    const name = request.body?.name;
    if (typeof name !== "string" || !name.trim() || name.length > 40) return reply.code(400).send({ error: "Enter a name (1–40 characters)." });
    const memberToken = secret();
    members.set(memberToken, { id: randomBytes(8).toString("hex"), name: name.trim(), seen: Date.now() });
    return { token: memberToken, snapshot: snapshot() };
  });
  app.register(async routes => {
    routes.addHook("preHandler", async (request, reply) => {
      expire();
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const member = members.get(token);
      if (!member) return reply.code(401).send({ error: "Session ended or connection expired. Join again." });
      member.seen = Date.now();
    });
    routes.get("/listen/state", () => snapshot());
    routes.post("/listen/command", { config: { rateLimit: { max: 30, timeWindow: 60000 } } }, async (request, reply) => {
      const command = validateListenCommand(request.body);
      if (command.type !== "add" && !allowControls) return reply.code(403).send({ error: "Only the host can control playback." });
      if (command.type === "add" && command.next && !allowControls) return reply.code(403).send({ error: "Only the host can choose Play next." });
      if (pendingCommands >= 5) return reply.code(429).send({ error: "The queue is busy. Try again in a moment." });
      const memberToken = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      pendingCommands++;
      const pending = commands
        .then(async () => {
          if (stopped || !members.has(memberToken)) throw new Error("The session has ended or you have left.");
          if (!allowControls && (command.type !== "add" || command.next)) throw new Error("The host has disabled guest playback controls.");
          await options.command(command);
        })
        .finally(() => {
          pendingCommands--;
        });
      commands = pending.catch(() => {});
      await pending;
      return { ok: true };
    });
    routes.post("/listen/leave", request => {
      members.delete(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
      return { ok: true };
    });
  });
  return {
    app,
    inviteToken,
    snapshot,
    setControls: (enabled: boolean) => {
      allowControls = enabled;
    }
  };
}
