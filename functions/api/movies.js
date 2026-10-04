// POST /api/movies — free movie picks from TMDB, tailored to the player's country.
//
// The game sends {where: "theatres" | "streaming", filter, count}. The country comes from Cloudflare
// (request.cf.country), so players in Canada get Canadian releases and streaming catalogues,
// players in Japan get Japan's, and so on. This picks PICK_COUNT at random and sends back
// {items: [{name, note}], found, country}.
//
// The TMDB key lives only here, as the TMDB_API_KEY secret. Lists are cached for 6 hours
// per country, mode and filter, so most requests never reach TMDB.

const PICK_COUNT = 5;
const CACHE_SECONDS = 6 * 60 * 60;
const TMDB = "https://api.themoviedb.org/3";
const ALLOWED_ORIGINS = []; // the game calls this from the same site, so no other sites are allowed

// The game's mood filters as TMDB genre ids (any one matches).
const FILTERS = {
  any: "",
  comfort: "16|10751|35",   // animation, family, comedy
  funny: "35",              // comedy
  scary: "27",              // horror
  feelings: "18|10749",     // drama, romance
  mind: "878|9648|53"       // sci-fi, mystery, thriller
};

const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
  18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Sci-fi", 10770: "TV movie", 53: "Thriller", 10752: "War", 37: "Western"
};

function cors(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
}

function reply(request, status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(request) }
  });
}

async function cached(key, compute) {
  const cache = caches.default;
  const req = new Request("https://cache.waiter-is-coming/" + encodeURIComponent(key));
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const value = await compute();
  if (value && value.length) {
    await cache.put(req, new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` }
    }));
  }
  return value;
}

const day = offset => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

// One TMDB "discover" search; two pages gives up to 40 movies to pick from.
async function discover(env, country, where, genres) {
  const params = {
    api_key: env.TMDB_API_KEY,
    language: "en-US",
    include_adult: "false",
    sort_by: "popularity.desc",
    ...(genres ? { with_genres: genres } : {}),
    ...(where === "streaming"
      ? { watch_region: country, with_watch_monetization_types: "flatrate", "vote_count.gte": "50" }
      // Theatrical releases in this country over the last ~6 weeks (TMDB's recipe for "now playing").
      : { region: country, with_release_type: "2|3", "release_date.gte": day(-42), "release_date.lte": day(7) })
  };
  const pages = await Promise.all([1, 2].map(async page => {
    const url = `${TMDB}/discover/movie?${new URLSearchParams({ ...params, page: String(page) })}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw { status: res.status };
    return (await res.json()).results || [];
  }));
  const seen = new Set();
  return pages.flat()
    .filter(m => m.title && !seen.has(m.id) && seen.add(m.id))
    .map(m => ({
      name: m.title.slice(0, 60),
      note: [
        (m.release_date || "").slice(0, 4),
        GENRES[(m.genre_ids || [])[0]],
        m.vote_count >= 20 && m.vote_average ? `${m.vote_average.toFixed(1)}★` : ""
      ].filter(Boolean).join(" · ")
    }));
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function onRequestPost({ request, env }) {
  if (!env.TMDB_API_KEY || env.TMDB_API_KEY.startsWith("paste-")) return reply(request, 503, { code: "not_configured" });

  let input;
  try { input = await request.json(); } catch { return reply(request, 400, { code: "bad_request" }); }
  const where = input?.where === "streaming" ? "streaming" : "theatres";
  const filter = Object.hasOwn(FILTERS, input?.filter) ? input.filter : "any";
  // The game says how many it wants (its PICKS setting); default PICK_COUNT, at most 12.
  const count = Number.isInteger(input?.count) ? Math.min(Math.max(input.count, 1), 12) : PICK_COUNT;
  // Cloudflare tells us the player's country; fall back to Canada when testing locally.
  const country = /^[A-Z]{2}$/.test(request.cf?.country || "") ? request.cf.country : "CA";

  try {
    let all = await cached(`movies:${country}:${where}:${filter}`, () => discover(env, country, where, FILTERS[filter]));
    // Small markets can have few theatrical releases with a given mood; drop the mood rather than fail.
    if (all.length < count && filter !== "any") {
      all = await cached(`movies:${country}:${where}:any`, () => discover(env, country, where, ""));
    }
    const pool = all.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return reply(request, 200, { items: pool.slice(0, count), found: pool.length, country });
  } catch (e) {
    console.error("TMDB error", e && (e.status || e.message || e));
    const code = e && e.status === 401 ? "not_configured" : e && e.status === 429 ? "rate_limited" : "upstream_error";
    return reply(request, code === "rate_limited" ? 429 : 502, { code });
  }
}
