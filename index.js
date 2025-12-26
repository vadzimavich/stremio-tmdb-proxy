const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const TMDB_KEY = process.env.TMDB_KEY;
const LANGUAGE = "ru-RU";

const builder = new addonBuilder({
  id: "org.tmdbproxy.translator.fix",
  version: "1.0.8",
  name: "TMDB Translator (RU)",
  description: "Попытка перевода Cinemeta. Включает тестовый каталог.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb"],
  // Оставляем один каталог для проверки работоспособности!
  catalogs: [
    { type: "movie", id: "tmdb.test", name: "TMDB TEST (RU)" }
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

const idCache = {};

async function getTmdbId(type, id) {
  if (id.startsWith("tmdb:")) return id.split(":")[1];
  if (id.startsWith("tt")) {
    if (idCache[id]) return idCache[id];
    try {
      if (!TMDB_KEY) throw new Error("No API Key");
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
  return id;
}

// --- КАТАЛОГ (Для теста) ---
builder.defineCatalogHandler(async ({ type, id }) => {
  // Просто возвращаем популярные, чтобы убедиться, что русский язык работает
  const url = `https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_KEY}&language=${LANGUAGE}`;
  try {
    const { data } = await axios.get(url);
    const metas = data.results.map(item => ({
      id: `tmdb:${item.id}`, // Используем tmdb ID чтобы точно видеть наши данные
      type: "movie",
      name: item.title,
      poster: proxyImage(item.poster_path),
      description: item.overview
    }));
    return { metas };
  } catch (e) {
    console.error("Catalog Error:", e.message);
    return { metas: [] };
  }
});

// --- МЕТАДАННЫЕ ---
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`Getting meta for: ${id}`);
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
      description: data.overview || "Нет описания.",
      releaseInfo: (data.release_date || data.first_air_date || "").substring(0, 4),
      runtime: formatRuntime(data.runtime || (data.episode_run_time ? data.episode_run_time[0] : null)),
      genres: data.genres ? data.genres.map(g => g.name) : [],
      imdbRating: data.vote_average ? data.vote_average.toFixed(1) : null,
      cast: data.credits?.cast?.slice(0, 8).map(c => c.name),
      trailers: trailers,
      behaviorHints: {
        defaultVideoId: trailers.length > 0 ? trailers[0].source : null
      }
    };
    return { meta };
  } catch (e) {
    console.error(`Meta Request Error: ${e.message}`);
    return { meta: {} };
  }
});

// --- ROUTER (РУЧНОЙ ПАРСИНГ) ---
const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // Убираем всё лишнее из URL
  let path = req.url.split('?')[0];
  // Убираем начальный слэш, если есть
  if (path.startsWith('/')) path = path.substring(1);

  // Разбиваем на части
  const parts = path.split('/');

  // Главная страница (путь пустой или index.js)
  if (path === '' || path === 'index.js' || path === 'configure') {
    res.statusCode = 302;
    res.setHeader('Location', '/manifest.json');
    res.end();
    return;
  }

  // Манифест
  if (path === 'manifest.json') {
    res.end(JSON.stringify(addonInterface.manifest));
    return;
  }

  // Обработка ресурсов: resource/type/id.json
  // Пример: meta/movie/tt123.json
  if (parts.length >= 3) {
    const resource = parts[0];
    const type = parts[1];
    const id = parts[2].replace('.json', '');

    if (addonInterface[resource]) {
      try {
        const result = await addonInterface[resource]({ type, id, extra: {} });
        // Ставим кеш поменьше для тестов (1 час)
        res.setHeader('Cache-Control', 'max-age=3600, public');
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error("Handler Failed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ err: 'Handler Error' }));
      }
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ err: `Resource ${resource} not found` }));
    }
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ err: 'Invalid Path', path: path }));
  }
};