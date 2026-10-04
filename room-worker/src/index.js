// Live rooms for The Waiter Is Coming.
//
// Each room code (e.g. "KQ7M") is one Durable Object holding the room's state. Phones connect
// over a WebSocket and get the full state after every change, so everyone in the room sees the
// same options, the same bracket order, the same votes and the same coin flips.
//
// Flow: lobby (host picks options) → duel (everyone votes, VOTE_SECONDS) → reveal (result shown,
// tie = coin flip) → next duel … → final. Randomness happens only here, never on the phones.

import { DurableObject } from "cloudflare:workers";

const VOTE_SECONDS = 15;
const REVEAL_SECONDS = 3;
const COIN_SECONDS = 4.5;
const MAX_PLAYERS = 12;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // a room (and the names in it) is deleted after a day of no activity

const shuffle = a => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get("state")) || null;
      if (this.s && Date.now() - this.s.lastActive > ROOM_TTL_MS) this.s = null;
    });
  }

  async save() {
    this.s.lastActive = Date.now();
    await this.ctx.storage.put("state", this.s);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/create") {
      if (this.s) return json({ error: "taken" }, 409);
      const { code, hostId } = await request.json();
      this.s = {
        code, hostId, phase: "lobby", players: [], category: "food", title: "", items: [],
        pool: [], next: [], round: 0, duel: null, votes: {}, result: null, history: [], winner: null, runnerUp: null,
        endsAt: 0, lastActive: Date.now()
      };
      await this.save();
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/exists") {
      return json({ exists: !!this.s, phase: this.s?.phase, players: this.s?.players.length || 0 });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      if (!this.s) return new Response("No such room", { status: 404 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response("Not found", { status: 404 });
  }

  // ---------- messages from phones ----------
  async webSocketMessage(ws, raw) {
    if (!this.s) return ws.close(1011, "Room closed");
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment()?.id;

    if (m.type === "hello") {
      const id = clean(m.id, 40);
      if (!id) return;
      let p = this.s.players.find(x => x.id === id);
      if (!p) {
        if (this.s.players.length >= MAX_PLAYERS) return this.send(ws, { type: "error", code: "room_full" });
        p = { id };
        this.s.players.push(p);
      }
      p.name = clean(m.name, 20) || "Player";
      p.who = clean(m.who, 12) || "usual";
      ws.serializeAttachment({ id });
      await this.save();
      return this.broadcast();
    }
    if (!me) return; // must say hello first
    const isHost = me === this.s.hostId;

    if (m.type === "start" && isHost && (this.s.phase === "lobby" || this.s.phase === "final")) {
      const seen = new Set();
      const items = (Array.isArray(m.items) ? m.items : [])
        .map(x => ({ name: clean(x?.name, 60), note: clean(x?.note, 80) }))
        .filter(x => x.name && !seen.has(x.name.toLowerCase()) && seen.add(x.name.toLowerCase()))
        .slice(0, 12);
      if (items.length < 2) return this.send(ws, { type: "error", code: "need_two" });
      Object.assign(this.s, {
        category: clean(m.category, 12) || "custom", title: clean(m.title, 40), items,
        pool: shuffle(items.map(x => x.name)), next: [], round: 1, history: [], winner: null, runnerUp: null
      });
      return this.nextDuel();
    }

    if (m.type === "vote" && this.s.phase === "duel" && (m.side === "a" || m.side === "b")) {
      this.s.votes[me] = m.side;
      await this.save();
      const online = this.onlineIds();
      if (online.length && online.every(id => this.s.votes[id])) return this.resolve();
      return this.broadcast();
    }

    if (m.type === "lobby" && isHost) {
      this.s.phase = "lobby";
      this.s.duel = null;
      await this.ctx.storage.deleteAlarm();
      await this.save();
      return this.broadcast();
    }
  }

  async webSocketClose(ws) {
    ws.close();
    if (!this.s) return;
    // Last person left: schedule the room's deletion (cancelled by anyone rejoining and playing).
    if (this.ctx.getWebSockets().length === 0 && this.s.phase !== "duel" && this.s.phase !== "reveal") {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    // If someone leaves mid-vote and everyone left has voted, don't make the room wait.
    if (this.s.phase === "duel") {
      const online = this.onlineIds();
      if (online.length && online.every(id => this.s.votes[id])) return this.resolve();
    }
    this.broadcast();
  }

  // ---------- game flow ----------
  async nextDuel() {
    const s = this.s;
    if (s.pool.length < 2) {
      s.pool = shuffle(s.next.concat(s.pool));
      s.next = [];
      s.round++;
      if (s.pool.length === 1) {
        s.phase = "final";
        s.winner = s.pool[0];
        s.duel = null;
        await this.ctx.storage.deleteAlarm();
        await this.save();
        return this.broadcast();
      }
    }
    s.duel = { a: s.pool.shift(), b: s.pool.shift() };
    s.votes = {};
    s.result = null;
    s.phase = "duel";
    s.endsAt = Date.now() + VOTE_SECONDS * 1000;
    await this.ctx.storage.setAlarm(s.endsAt);
    await this.save();
    this.broadcast();
  }

  async resolve() {
    const s = this.s;
    if (s.phase !== "duel") return;
    const votes = Object.values(s.votes);
    const va = votes.filter(v => v === "a").length, vb = votes.length - va;
    const coin = va === vb; // tie, including nobody voting
    const heads = Math.random() < 0.5;
    const winA = coin ? heads : va > vb;
    const winner = winA ? s.duel.a : s.duel.b, loser = winA ? s.duel.b : s.duel.a;
    s.result = { va, vb, coin, heads, winner };
    s.history.push({ a: s.duel.a, b: s.duel.b, va, vb, coin, winner });
    s.next.push(winner);
    s.runnerUp = loser;
    s.phase = "reveal";
    s.endsAt = Date.now() + (coin ? COIN_SECONDS : REVEAL_SECONDS) * 1000;
    await this.ctx.storage.setAlarm(s.endsAt);
    await this.save();
    this.broadcast();
  }

  async alarm() {
    if (!this.s) return;
    // Nobody here and nothing happened for a day: delete everything, including player names.
    if (this.ctx.getWebSockets().length === 0 && Date.now() - this.s.lastActive >= ROOM_TTL_MS - 1000) {
      this.s = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    // Everyone left mid-game: stop the game and schedule the room's deletion.
    if (this.ctx.getWebSockets().length === 0) {
      this.s.phase = "lobby";
      this.s.duel = null;
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    if (this.s.phase === "duel") return this.resolve();
    if (this.s.phase === "reveal") return this.nextDuel();
  }

  // ---------- sending ----------
  onlineIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const id = ws.deserializeAttachment()?.id;
      if (id) ids.add(id);
    }
    return [...ids];
  }

  view() {
    const s = this.s, online = new Set(this.onlineIds());
    return {
      code: s.code, hostId: s.hostId, phase: s.phase, category: s.category, title: s.title, items: s.items,
      round: s.round, duel: s.duel, result: s.result, winner: s.winner, runnerUp: s.runnerUp,
      endsIn: Math.max(0, s.endsAt - Date.now()), voteSeconds: VOTE_SECONDS,
      totalDuels: Math.max(0, s.items.length - 1), played: s.history.length,
      players: s.players.map(p => ({ id: p.id, name: p.name, who: p.who, online: online.has(p.id), voted: !!s.votes[p.id] })),
      // Who voted for what is shown only once the round is over.
      votes: s.phase === "duel" ? null : s.votes
    };
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  broadcast() {
    const msg = JSON.stringify({ type: "state", state: this.view() });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }
}

// The worker itself only routes to rooms; the game site normally reaches rooms through its
// ROOMS binding (see functions/api/room). Direct requests are refused.
export default {
  async fetch() {
    return new Response("waiter-rooms", { status: 404 });
  }
};
