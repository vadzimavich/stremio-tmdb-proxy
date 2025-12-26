require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const TMDB_KEY = process.env.TMDB_KEY;
const LANGUAGE = "ru-RU";

const builder = new addonBuilder({
  id: "org.tmdbproxy.by",
  version: "1.0.3",
  name: "TMDB Proxy (BY/RU)",
  description: "Постеры, описание и трейлеры на русском. Обход блокировки.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["tmdb", "tt"],
  catalogs: [
    { type: "movie", id: "tmdb.trending", name: "TMDB: Фильмы (RU)" },
    { type: "series", id: "tmdb.series", name: "TMDB: Сериалы (RU)" }
  ]
});

// --- ХЕЛПЕРЫ ---

// 1. Прокси для постеров (w500)
function proxyImage(path) {
  if (!path) return null;
  const originalUrl = `https://image.tmdb.org/t/p/w500${path}`;
  return `https://wsrv.nl/?url=${encodeURIComponent(originalUrl)}`;
}

// 2. Прокси для фона (максимальное качество)
function proxyBackground(path) {
  if (!path) return null;
  const originalUrl = `https://image.tmdb.org/t/p/original${path}`;
  return `https://wsrv.nl/?url=${encodeURIComponent(originalUrl)}`;
}

// 3. Форматирование времени: 103 -> "1 ч 43 мин"
function formatRuntime(minutes) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;

  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;

  // Можно сделать "час/часа", но "ч" и "мин" универсальнее для интерфейса
  return `${h} ч ${m} мин`;
}

// 4. Конвертер IMDb ID (tt123) -> TMDB ID (123)
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

  // Запрашиваем всё сразу: инфо, видео, картинки, актеров
  const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_KEY}&language=${LANGUAGE}&append_to_response=videos,images,credits`;

  try {
    const { data } = await axios.get(url);

    // --- ТРЕЙЛЕРЫ ---
    // Фильтруем только YouTube трейлеры
    const trailers = data.videos?.results
      .filter(v => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"))
      .map(t => ({
        source: t.key, // ID видео на YouTube
        type: "Trailer"
      })) || [];

    // --- ФОРМИРОВАНИЕ МЕТАДАННЫХ ---
    const meta = {
      id: id,
      type: type,
      name: data.title || data.name,
      poster: proxyImage(data.poster_path),
      background: proxyBackground(data.backdrop_path),
      // Логотип (если есть прозрачный PNG с названием)
      logo: data.images?.logos?.length > 0 ? proxyImage(data.images.logos[0].file_path) : null,
      description: data.overview || "Описание отсутствует.",
      releaseInfo: (data.release_date || data.first_air_date || "").substring(0, 4),

      // Вот наше красивое время:
      runtime: formatRuntime(data.runtime || (data.episode_run_time ? data.episode_run_time[0] : null)),

      genres: data.genres ? data.genres.map(g => g.name) : [],
      imdbRating: data.vote_average ? data.vote_average.toFixed(1) : null,
      cast: data.credits?.cast?.slice(0, 8).map(c => c.name), // Топ-8 актеров
      director: data.credits?.crew?.filter(c => c.job === "Director").map(c => c.name), // Режиссеры

      // Кнопка Трейлер в интерфейсе
      trailers: trailers,
      behaviorHints: {
        defaultVideoId: trailers.length > 0 ? trailers[0].source : null // Иногда помогает автовыбору
      }
    };

    return { meta };
  } catch (e) {
    console.error(`Meta Error for ${id}:`, e.message);
    return { meta: {} };
  }
});

const interface = builder.getInterface();
module.exports = (req, res) => {
  return interface(req, res);
};