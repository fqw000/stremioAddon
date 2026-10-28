/**
 * Vercel Edge Function 入口
 */

import { getManifest } from '../src/manifest.js';
import { catalogHandler } from '../src/handlers/catalog.js';
import { metaHandler } from '../src/handlers/meta.js';
import { streamHandler } from '../src/handlers/stream.js';

export const config = { runtime: 'edge' };

export default async function (req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS 预检
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors() });
    }

    try {
        // ============================================================
        // Manifest
        // ============================================================
        if (path === '/manifest.json' || path === '/') {
            return json(getManifest(), 200, 'public, max-age=300');
        }

        // ============================================================
        // Catalog
        // ============================================================
        const catalogMatch = path.match(/^\/catalog\/([^/]+)\/(.+)\.json$/);
        if (catalogMatch) {
            const [, type, id] = catalogMatch;
            const extra = {};
            for (const [k, v] of url.searchParams) extra[k] = v;
            const result = await catalogHandler({
                id: decodeURIComponent(id),
                type,
                extra,
            });
            return json(result, 200, 'public, max-age=300');
        }

        // ============================================================
        // Meta
        // ============================================================
        const metaMatch = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
        if (metaMatch) {
            const [, type, id] = metaMatch;
            const result = await metaHandler({
                id: decodeURIComponent(id),
                type,
            });
            return json(result, 200, 'public, max-age=1800');
        }

        // ============================================================
        // Stream
        // ============================================================
        const streamMatch = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
        if (streamMatch) {
            const [, type, id] = streamMatch;
            const result = await streamHandler({
                id: decodeURIComponent(id),
                type,
            });
            return json(result, 200, 'public, max-age=60');
        }

        return new Response('Not Found', { status: 404 });
    } catch (e) {
        return json({ error: e.message, stack: e.stack?.slice(0, 500) }, 500);
    }
}

function json(data, status = 200, cacheControl) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        ...cors(),
    };
    if (cacheControl) headers['Cache-Control'] = cacheControl;
    return new Response(JSON.stringify(data), { status, headers });
}

function cors() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
}