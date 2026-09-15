import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ListenCommand, ListenGuestRequest, ListenPlayback, ListenSnapshot, summarizeListenCommand, validateListenCommand } from "../../shared/listen-together";

const secret = () => randomBytes(32).toString("hex");
const equal = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createListenServer(options: { name: string; getPlayback: () => ListenPlayback; command: (command: ListenCommand) => Promise<void> }) {
  const app = Fastify({ bodyLimit: 4096, requestTimeout: 10000, connectionTimeout: 10000 });
  await app.register(rateLimit, { max: 1800, timeWindow: 60000 });
  const inviteToken = secret();
  const members = new Map<string, { id: string; name: string; seen: number }>();
  const requests: ListenGuestRequest[] = [];
  let allowControls = false;
  let commands = Promise.resolve();
  let pendingCommands = 0;
  let stopped = false;
  const record = (entry: Omit<ListenGuestRequest, "id" | "at">) => {
    requests.unshift({ id: randomBytes(6).toString("hex"), at: Date.now(), ...entry });
    if (requests.length > 100) requests.length = 100;
  };
  app.addHook("preClose", async () => {
    stopped = true;
    members.clear();
    requests.length = 0;
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
    const member = { id: randomBytes(8).toString("hex"), name: name.trim(), seen: Date.now() };
    members.set(memberToken, member);
    record({ memberId: member.id, memberName: member.name, kind: "join", summary: "joined the session", ok: true });
    return { token: memberToken, snapshot: snapshot() };
  });
  app.register(async routes => {
    routes.addHook("preHandler", async (request, reply) => {
      expire();
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const member = members.get(token);
      if (!member) return reply.code(401).send({ error: "Session ended or connection expired. Join again." });
      member.seen = Date.now();
      (request as typeof request & { listenMember: { id: string; name: string } }).listenMember = member;
    });
    routes.get("/listen/state", () => snapshot());
    routes.post("/listen/command", { config: { rateLimit: { max: 30, timeWindow: 60000 } } }, async (request, reply) => {
      const member = (request as typeof request & { listenMember: { id: string; name: string } }).listenMember;
      let command: ListenCommand;
      try {
        command = validateListenCommand(request.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid session command.";
        record({ memberId: member.id, memberName: member.name, kind: "command", summary: "invalid command", ok: false, error: message });
        return reply.code(400).send({ error: message });
      }
      const summary = summarizeListenCommand(command);
      const guestFree = command.type === "playNow" || command.type === "remove" || (command.type === "add" && !command.next);
      if (command.type === "add" && command.next && !allowControls) {
        record({ memberId: member.id, memberName: member.name, kind: "command", summary, ok: false, error: "Only the host can choose Play next." });
        return reply.code(403).send({ error: "Only the host can choose Play next." });
      }
      if (!guestFree && !allowControls) {
        record({ memberId: member.id, memberName: member.name, kind: "command", summary, ok: false, error: "Only the host can control playback." });
        return reply.code(403).send({ error: "Only the host can control playback." });
      }
      if (pendingCommands >= 5) {
        record({ memberId: member.id, memberName: member.name, kind: "command", summary, ok: false, error: "The queue is busy. Try again in a moment." });
        return reply.code(429).send({ error: "The queue is busy. Try again in a moment." });
      }
      const memberToken = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      pendingCommands++;
      const pending = commands
        .then(async () => {
          if (stopped || !members.has(memberToken)) throw new Error("The session has ended or you have left.");
          if (!allowControls && !guestFree) throw new Error("The host has disabled guest playback controls.");
          await options.command(command);
          record({ memberId: member.id, memberName: member.name, kind: "command", summary, ok: true });
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : "Session command failed.";
          record({ memberId: member.id, memberName: member.name, kind: "command", summary, ok: false, error: message });
          throw error;
        })
        .finally(() => {
          pendingCommands--;
        });
      commands = pending.catch(() => {});
      await pending;
      return { ok: true };
    });
    routes.post("/listen/leave", request => {
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const member = members.get(token);
      if (member) record({ memberId: member.id, memberName: member.name, kind: "leave", summary: "left the session", ok: true });
      members.delete(token);
      return { ok: true };
    });
  });
  return {
    app,
    inviteToken,
    snapshot,
    requests: () => requests.slice(),
    setControls: (enabled: boolean) => {
      allowControls = enabled;
    }
  };
}
