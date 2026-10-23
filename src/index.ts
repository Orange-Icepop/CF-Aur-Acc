/**
 * AUR 反向代理 Cloudflare Worker
 *
 * 部署：
 *   npm i -g wrangler && wrangler login
 *   wrangler deploy
 *   然后在 CF 控制台给 Worker 绑定自定义域名（必须是根路径，例如 aur.example.com）
 *
 * paru.conf:
 *   AurUrl = https://aur.example.com
 *   AurRpcUrl = https://aur.example.com/rpc   # 若 env.RPC_ORIGIN 未设置则回源官方 AUR
 *
 * 可选环境变量：
 *   AUR_ORIGIN  默认 https://aur.archlinux.org
 *   RPC_ORIGIN  例如 https://rpc.example.com（指向你自己的 goaurrpc，避免 RPC 走官方）
 *
 * 设计取舍：
 *   - git 的 POST 请求体很小（几 KB），buffer 后转发最稳；
 *   - 不读 GET 响应的 body（除了可缓存的小请求），保持 Content-Encoding 原样透传；
 *   - 只对 /cgit/* 和 /rpc 的 GET 做边缘缓存，git 的 info/refs 不缓存（避免 refs 过期）。
 */

const DEFAULT_AUR_ORIGIN = "https://aur.archlinux.org";
const CACHE_TTL_SECONDS = 300;

// 逐跳头 + Cloudflare 注入头，转给源站会引起歧义
const DROP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-proto",
  "x-real-ip",
]);

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!ALLOWED_METHODS.has(request.method)) {
      return new Response("method not allowed\n", {
        status: 405,
        headers: { allow: "GET, HEAD, POST" },
      });
    }

    const isRpc = url.pathname === "/rpc" || url.pathname.startsWith("/rpc/");
    const origin = (
      isRpc && env.RPC_ORIGIN
        ? env.RPC_ORIGIN
        : env.AUR_ORIGIN || DEFAULT_AUR_ORIGIN
    ).replace(/\/+$/, "");

    const target = origin + url.pathname + url.search;

    // 只缓存小体量的 GET；git 走 POST，天然不缓存
    const isCacheable =
      request.method === "GET" &&
      (url.pathname.startsWith("/cgit/") || isRpc) &&
      !request.headers.has("authorization");

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });

    if (isCacheable) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const h = new Headers(hit.headers);
        h.set("x-aur-cache", "HIT");
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    }

    const headers = new Headers();
    for (const [k, v] of request.headers) {
      if (!DROP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    }
    // 不主动要求压缩，减少二进制透传时的解压/重压风险
    headers.delete("accept-encoding");

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method === "POST") {
      init.body = await request.arrayBuffer();
    }

    const upstream = await fetch(target, init);

    // 可缓存且源站没压缩：读进内存，写边缘缓存
    if (isCacheable && upstream.ok && !upstream.headers.has("content-encoding")) {
      const body = await upstream.arrayBuffer();
      const h = new Headers(upstream.headers);
      h.set("cache-control", "public, max-age=" + CACHE_TTL_SECONDS);
      h.set("x-aur-cache", "MISS");
      const response = new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: h,
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // 其余（包括所有 git 请求）原样流式透传，保持 Content-Encoding 不变
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  },
};
