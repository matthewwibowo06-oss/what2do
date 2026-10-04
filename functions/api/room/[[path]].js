// /api/room/... — connects phones to live rooms (the Room Durable Object in room-worker/).
//
//   POST /api/room/create        {hostId}  → {code}   new room with a fresh 4-letter code
//   GET  /api/room/<CODE>                  → {exists, phase, players}
//   GET  /api/room/<CODE>/ws  (WebSocket)  → live connection to that room

// No look-alike characters (0/O, 1/I/L) so codes are easy to read out loud.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{4}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const newCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join("");
};

const room = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

export async function onRequest({ request, env, params }) {
  if (!env.ROOMS) return json({ code: "not_configured" }, 503);
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);

  if (request.method === "POST" && parts.length === 1 && parts[0] === "create") {
    let body = {};
    try { body = await request.json(); } catch {}
    const hostId = typeof body.hostId === "string" ? body.hostId.slice(0, 40) : "";
    if (!hostId) return json({ code: "bad_request" }, 400);
    // A code might already be in use; try a few.
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const res = await room(env, code).fetch("https://room/create", {
        method: "POST", body: JSON.stringify({ code, hostId })
      });
      if (res.ok) return json({ code });
    }
    return json({ code: "busy" }, 503);
  }

  const code = (parts[0] || "").toUpperCase();
  if (!CODE_RE.test(code)) return json({ code: "bad_code" }, 400);

  if (parts.length === 1 && request.method === "GET") {
    return room(env, code).fetch("https://room/exists");
  }
  if (parts.length === 2 && parts[1] === "ws" && request.headers.get("Upgrade") === "websocket") {
    return room(env, code).fetch(request);
  }
  return json({ code: "not_found" }, 404);
}
