const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const TMDB_KEY = process.env.TMDB_KEY;
const LANGUAGE = "ru-RU";

const builder = new addonBuilder({
  id: "org.tmdbproxy.translator",
  version: "1.0.6",
  name: "TMDB Translator (RU)",
  description: "Перевод описания и постеров на русский язык.",
  resources: ["meta"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb"]
});

// --- ХЕЛПЕРЫ ---
function proxyImage(path) {
  if (!path) return null;
  const originalUrl = `https://image.tmdb.org/t/p/w500${path}`;
  return `https://wsrv.nl/?url=${encodeURIComponent(originalUrl)}`;
}

function proxyBackground(path) {
  if (!path) return null;
  const originalUrl = `https://image.tmdb.org/t/p/original${path}`;
  return `https://wsrv.nl/?url=${encodeURIComponent(originalUrl)}`;
}

function formatRuntime(minutes) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

// Кэш ID
const idCache = {};

async function getTmdbId(type, id) {
  if (id.startsWith("tmdb:")) return id.split(":")[1];
  if (id.startsWith("tt")) {
    if (idCache[id]) return idCache[id];
    try {
      if (!TMDB_KEY) throw new Error("TMDB_KEY is missing");
      const findUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_KEY}&external_source=imdb_id`;
      const { data } = await axios.get(findUrl);
      const result = type === "movie" ? data.movie_results[0] : data.tv_results[0];
      if (result) {
        idCache[id] = result.id;
        return result.id;
      }
    } catch (e) {
      console.error("ID Convert Error:", e.message);
    }
  }
  return id; // Возвращаем как есть, если не нашли
}

// --- ЛОГИКА АДДОНА ---
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`Processing Meta: ${type} / ${id}`); // ЛОГ

  const tmdbId = await getTmdbId(type, id);
  if (!tmdbId) return { meta: {} };

  const tmdbType = type === "movie" ? "movie" : "tv";
  const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_KEY}&language=${LANGUAGE}&append_to_response=videos,images,credits`;

  try {
    const { data } = await axios.get(url);

    const trailers = data.videos?.results
      .filter(v => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"))
      .map(t => ({ source: t.key, type: "Trailer" })) || [];

    const meta = {
      id: id,
      type: type,
      name: data.title || data.name,
      poster: proxyImage(data.poster_path),
      background: proxyBackground(data.backdrop_path),
      logo: data.images?.logos?.length > 0 ? proxyImage(data.images.logos[0].file_path) : null,
      description: data.overview || "Описание на русском отсутствует.",
      releaseInfo: (data.release_date || data.first_air_date || "").substring(0, 4),
      runtime: formatRuntime(data.runtime || (data.episode_run_time ? data.episode_run_time[0] : null)),
      genres: data.genres ? data.genres.map(g => g.name) : [],
      imdbRating: data.vote_average ? data.vote_average.toFixed(1) : null,
      cast: data.credits?.cast?.slice(0, 8).map(c => c.name),
      director: data.credits?.crew?.filter(c => c.job === "Director").map(c => c.name),
      trailers: trailers,
      behaviorHints: {
        defaultVideoId: trailers.length > 0 ? trailers[0].source : null
      }
    };
    return { meta };
  } catch (e) {
    console.error(`TMDB Request Error: ${e.message}`);
    return { meta: {} };
  }
});

// --- ROUTER VERCEL (FIXED) ---
const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
  try {
    // Логируем входящий запрос для отладки
    console.log(`Request: ${req.method} ${req.url}`);

    // CORS заголовки (обязательно)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }

    // Чистим URL
    const cleanUrl = req.url.split('?')[0];

    // Главная
    if (cleanUrl === '/' || cleanUrl === '/configure') {
      res.statusCode = 302;
      res.setHeader('Location', '/manifest.json');
      res.end();
      return;
    }

    // Манифест
    if (cleanUrl === '/manifest.json') {
      res.end(JSON.stringify(addonInterface.manifest));
      return;
    }

    // Ловим запросы вида /meta/type/id.json
    // Используем Regex, он надежнее для Vercel путей
    const match = cleanUrl.match(/\/([^/]+)\/([^/]+)\/([^/]+)\.json/);

    if (match) {
      const resource = match[1]; // meta
      const type = match[2];     // movie
      const id = match[3];       // tt12345

      if (addonInterface[resource]) {
        const result = await addonInterface[resource]({ type, id, extra: {} });

        // Кеш на 4 часа
        res.setHeader('Cache-Control', 'max-age=14400, public');
        res.end(JSON.stringify(result));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ err: 'Resource not supported' }));
      }
    } else {
      // Если путь не распознан
      console.log(`Unknown path: ${cleanUrl}`);
      res.statusCode = 404;
      res.end(JSON.stringify({ err: 'Not found', path: cleanUrl }));
    }

  } catch (error) {
    // Глобальный перехват ошибок
    console.error("CRITICAL ERROR:", error);
    res.statusCode = 500;
    res.end(JSON.stringify({
      err: 'Server Error',
      details: error.message,
      stack: error.stack
    }));
  }
};