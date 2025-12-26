const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const TMDB_KEY = process.env.TMDB_KEY;
const LANGUAGE = "ru-RU";

const builder = new addonBuilder({
  id: "org.tmdbproxy.translator",
  version: "1.0.5",
  name: "TMDB Translator (RU)",
  description: "Переводит описание и постеры Cinemeta на русский язык (через TMDB Proxy).",
  // Оставляем только meta (информация о фильме)
  resources: ["meta"],
  types: ["movie", "series"],
  // Перехватываем стандартные ID (tt...) и TMDB ID
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

// Кэш для ID, чтобы не спамить запросами find
const idCache = {};

async function getTmdbId(type, id) {
  if (id.startsWith("tmdb:")) return id.split(":")[1];

  // Если это IMDb ID (tt12345)
  if (id.startsWith("tt")) {
    if (idCache[id]) return idCache[id]; // Возврат из кэша

    try {
      const findUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_KEY}&external_source=imdb_id`;
      const { data } = await axios.get(findUrl);
      const result = type === "movie" ? data.movie_results[0] : data.tv_results[0];

      if (result) {
        idCache[id] = result.id; // Запоминаем
        return result.id;
      }
      return null;
    } catch (e) {
      console.error("ID Convert Error:", e.message);
      return null;
    }
  }
  return id;
}

// --- ОБРАБОТЧИК МЕТАДАННЫХ ---

builder.defineMetaHandler(async ({ type, id }) => {
  // 1. Получаем TMDB ID
  const tmdbId = await getTmdbId(type, id);
  if (!tmdbId) {
    // Если не нашли в TMDB, возвращаем пустой объект (Stremio покажет дефолтную Cinemeta)
    return { meta: {} };
  }

  const tmdbType = type === "movie" ? "movie" : "tv";

  // Запрашиваем данные
  const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_KEY}&language=${LANGUAGE}&append_to_response=videos,images,credits`;

  try {
    const { data } = await axios.get(url);

    // Трейлеры
    const trailers = data.videos?.results
      .filter(v => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"))
      .map(t => ({ source: t.key, type: "Trailer" })) || [];

    // Формируем ответ
    const meta = {
      id: id, // Возвращаем тот же ID (tt...), чтобы заменить Cinemeta
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
    console.error(`Meta Error for ${id}:`, e.message);
    return { meta: {} };
  }
});

// --- ИСПРАВЛЕННЫЙ РОУТЕР ДЛЯ VERCEL ---
const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');

  // Очищаем URL от параметров (?foo=bar)
  const cleanUrl = req.url.split('?')[0];

  // Главная страница
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

  // Парсинг ресурса: /meta/movie/tt12345.json
  // Используем split вместо regex для надежности
  const parts = cleanUrl.split('/');
  // parts[0] = "", parts[1] = resource, parts[2] = type, parts[3] = id.json

  if (parts.length >= 4) {
    const resource = parts[1];
    const type = parts[2];
    const idWithJson = parts[3];
    const id = idWithJson.replace('.json', ''); // Убираем .json

    if (addonInterface[resource]) {
      try {
        // Вызываем обработчик
        const result = await addonInterface[resource]({ type, id, extra: {} });

        // Кешируем (важно для скорости)
        res.setHeader('Cache-Control', 'max-age=86400, public'); // 1 день
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error("Handler crashed:", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ err: 'Handler failed' }));
      }
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ err: 'Resource not found' }));
    }
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ err: 'Invalid URL structure' }));
  }
};