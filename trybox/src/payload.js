// packages/src/payload.js

/** 构建 trybox 通用请求 payload */
function buildBasePayload(key, value) {
  return {
    t: {
      t: 10,
      i: 0,
      p: {
        k: ['data'],
        v: [
          {
            t: 10,
            i: 1,
            p: { k: [key], v: [value] },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

/** Catalog 请求 payload */
export function buildCatalogPayload(page = 'home') {
  return {
    t: {
      t: 10,
      i: 0,
      p: {
        k: ['data'],
        v: [
          {
            t: 10,
            i: 1,
            p: { k: ['page'], v: [{ t: 1, s: page }] },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

/** Search 请求 payload */
export function buildSearchPayload(query, type = 'multi') {
  return {
    t: {
      t: 10,
      i: 0,
      p: {
        k: ['data'],
        v: [
          {
            t: 10,
            i: 1,
            p: {
              k: ['query', 'type'],
              v: [
                { t: 1, s: query },
                { t: 1, s: type },
              ],
            },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

/** Meta 请求 payload */
export function buildMetaPayload(type, id) {
  return {
    t: {
      t: 10,
      i: 0,
      p: {
        k: ['data'],
        v: [
          {
            t: 10,
            i: 1,
            p: {
              k: ['type', 'id'],
              v: [
                { t: 1, s: type },
                { t: 0, s: Number(id) },
              ],
            },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

/** Episodes 请求 payload */
export function buildEpisodesPayload(tvId, seasonNumber) {
  return {
    t: {
      t: 10,
      i: 0,
      p: {
        k: ['data'],
        v: [
          {
            t: 10,
            i: 1,
            p: {
              k: ['id', 'season'],
              v: [
                { t: 0, s: Number(tvId) },
                { t: 0, s: Number(seasonNumber) },
              ],
            },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

/** Stream 请求 payload */
export function buildStreamPayload({ tmdbId, kind, season, episode }) {
  const dataObj =
    kind === 'tv'
      ? {
          t: 10,
          i: 1,
          p: {
            k: ['tmdb_id', 'kind', 'season', 'episode'],
            v: [
              { t: 0, s: tmdbId },
              { t: 1, s: 'tv' },
              { t: 0, s: season },
              { t: 0, s: episode },
            ],
          },
          o: 0,
        }
      : {
          t: 10,
          i: 1,
          p: {
            k: ['tmdb_id', 'kind'],
            v: [
              { t: 0, s: tmdbId },
              { t: 1, s: 'movie' },
            ],
          },
          o: 0,
        };

  return {
    t: { t: 10, i: 0, p: { k: ['data'], v: [dataObj] }, o: 0 },
    f: 127,
    m: [],
  };
}