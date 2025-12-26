// require('dotenv').config(); // На Vercel это не нужно, там свои переменные
const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const TMDB_KEY = process.env.TMDB_KEY;
const LANGUAGE = "ru-RU";

const builder = new addonBuilder({
  id: "org.tmdbproxy.by",
  version: "1.0.4",
  name: "TMDB Proxy (BY/RU)",
  description: "TMDB без VPN. Постеры и описание на русском.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["tmdb", "tt"],
  catalogs: [
    { type: "movie", id: "tmdb.trending", name: "TMDB: Фильмы (RU)" },
    { type: "series", id: "tmdb.series", name: "TMDB: Сериалы (RU)" }
  ]
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

async function getTmdbId(type, id) {
  if (id.startsWith("tmdb:")) return id.split(":")[1];
  if (id.startsWith("tt")) {
    try {
      const findUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_KEY}&external_source=imdb_id`;
      const { data } = await axios.get(findUrl);
      const result = type === "movie" ? data.movie_results[0] : data.tv_results[0];
      return result ? result.id : null;
    } catch (e) {
      console.error("ID Convert Error:", e.message);
      return null;
    }
  }
  return id;
}

// --- ОБРАБОТЧИКИ ---

builder.defineCatalogHandler(async ({ type, id }) => {
  let url = "";
  if (type === "movie" && id === "tmdb.trending") {
    url = `https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_KEY}&language=${LANGUAGE}`;
  } else if (type === "series" && id === "tmdb.series") {
    url = `https://api.themoviedb.org/3/trending/tv/week?api_key=${TMDB_KEY}&language=${LANGUAGE}`;
  } else {
    return { metas: [] };
  }

  try {
    const { data } = await axios.get(url);
    const metas = data.results.map(item => ({
      id: `tmdb:${item.id}`,
      type: type,
      name: item.title || item.name,
      poster: proxyImage(item.poster_path),
      description: item.overview
    }));
    return { metas };
  } catch (e) {
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
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
      description: data.overview || "Описание отсутствует.",
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
    console.error(`Meta Error for ${id}:`, e.message);
    return { meta: {} };
  }
});

// --- FIX ДЛЯ VERCEL (РУЧНОЙ РОУТЕР) ---
const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
  // 1. Настраиваем CORS (обязательно для аддонов)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');

  // 2. Обрабатываем корневой запрос и конфиг
  if (req.url === '/' || req.url === '/configure') {
    res.statusCode = 302;
    res.setHeader('Location', '/manifest.json');
    res.end();
    return;
  }

  // 3. Отдаем манифест
  if (req.url === '/manifest.json') {
    res.end(JSON.stringify(addonInterface.manifest));
    return;
  }

  // 4. Парсим URL: /resource/type/id.json
  // Пример: /meta/movie/tmdb:123.json
  const match = req.url.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\.json$/);

  if (!match) {
    res.statusCode = 404;
    res.end(JSON.stringify({ err: 'Not found' }));
    return;
  }

  const [_, resource, type, id] = match;

  // 5. Вызываем обработчик SDK
  if (addonInterface[resource]) {
    try {
      const result = await addonInterface[resource]({ type, id, extra: {} });
      // Кешируем ответ на 1 час (Vercel CDN)
      res.setHeader('Cache-Control', 'max-age=3600, public');
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error(e);
      res.statusCode = 500;
      res.end(JSON.stringify({ err: 'Handler error' }));
    }
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ err: 'Resource not supported' }));
  }
};