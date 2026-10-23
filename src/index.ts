/**
 * AUR 反向代理 Cloudflare Worker（路径白名单版）
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
 * 安全策略（防钓鱼）：
 *   - 只放行 paru 真正会用到的路径，其余一律 403 "Not permitted"；
 *   - 不返回任何 AUR 的 HTML 页面（/、/login、/register、/packages 索引等都被挡住），
 *     这样这个域名不会看起来像 AUR 的克隆站；
 *   - 所有响应都带 X-Robots-Tag: noindex, nofollow。
 *
 * 放行清单：
 *   GET/POST /rpc                                   RPC（可路由到 goaurrpc）
 *   GET      /<pkg>/info/refs?service=git-upload-pack   git smart http
 *   POST     /<pkg>/git-upload-pack                 git smart http
 *   GET      /cgit/aur.git/plain/PKGBUILD           paru -Gp
 *   GET      /cgit/aur.git/plain/.SRCINFO           兼容其它工具
 *   GET      /cgit/aur.git/snapshot/<pkg>.tar.gz    兼容其它工具
 *   （可选）/packages/<pkg>                          paru --comments，默认关闭
 */

const DEFAULT_AUR_ORIGIN = "https://aur.archlinux.org";
const CACHE_TTL_SECONDS = 300;

// paru --comments 会请求 /packages/<name>，返回的是 AUR 的 HTML 页面。
// 默认关闭，避免这个域名被识别成 AUR 的克隆/钓鱼站。需要的话改成 true。
const ALLOW_PACKAGE_PAGES = false;

// aurweb 允许的 pkgbase 字符集
const NAME = "[A-Za-z0-9@._+-]+";

const RE_RPC = /^\/rpc(?:\/.*)?$/;
const RE_INFO_REFS = new RegExp("^/" + NAME + "(?:\\.git)?/info/refs$");
const RE_UPLOAD_PACK = new RegExp("^/" + NAME + "(?:\\.git)?/git-upload-pack$");
const RE_CGIT_PLAIN = /^\/cgit\/aur\.git\/plain\/(PKGBUILD|\.SRCINFO)$/;
const RE_CGIT_SNAPSHOT = new RegExp("^/cgit/aur\\.git/snapshot/" + NAME + "\\.tar\\.gz$");
const RE_PACKAGE_PAGE = new RegExp("^/packages/" + NAME + "$");

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

function notPermitted() {
  return new Response("Not permitted\n", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function isAllowed(method, url) {
  const p = url.pathname;

  if (RE_RPC.test(p)) {
    return method === "GET" || method === "HEAD" || method === "POST";
  }

  if (RE_INFO_REFS.test(p)) {
    // 只允许 read-only 的 upload-pack；receive-pack（push）一律拒绝
    return (
      (method === "GET" || method === "HEAD") &&
      url.searchParams.get("service") === "git-upload-pack"
    );
  }

  if (RE_UPLOAD_PACK.test(p)) {
    return method === "POST";
  }

  if (RE_CGIT_PLAIN.test(p) || RE_CGIT_SNAPSHOT.test(p)) {
    return method === "GET" || method === "HEAD";
  }

  if (ALLOW_PACKAGE_PAGES && RE_PACKAGE_PAGE.test(p)) {
    return method === "GET" || method === "HEAD";
  }

  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 非白名单路径：统一 403，不暴露任何 AUR 页面
    if (!isAllowed(request.method, url)) {
      return notPermitted();
    }

    const isRpc = RE_RPC.test(url.pathname);
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
        h.set("x-robots-tag", "noindex, nofollow");
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
      h.set("x-robots-tag", "noindex, nofollow");
      const response = new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: h,
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // 其余（包括所有 git 请求）原样流式透传，保持 Content-Encoding 不变
    const outHeaders = new Headers(upstream.headers);
    outHeaders.set("x-robots-tag", "noindex, nofollow");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  },
};
