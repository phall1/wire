// Cloudflare Pages Function: dual-serving + CORS.
// Static assets (HTML, .json twins, llms.txt) and the _redirects file already
// cover most needs. This adds Accept-based content negotiation on bare entry
// paths (Accept: application/json → serve the .json twin) and permissive CORS.
interface Ctx {
  request: Request;
  next: (input?: Request) => Promise<Response>;
}

export const onRequest = async (context: Ctx): Promise<Response> => {
  const { request, next } = context;
  const url = new URL(request.url);
  const accept = request.headers.get("accept") || "";
  const path = url.pathname;
  const hasExt = /\.[a-z0-9]+$/i.test(path);
  const isBareEntry = !hasExt && path !== "/" && !path.endsWith("/");

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "accept",
      },
    });
  }

  let res: Response;
  if (isBareEntry && accept.includes("application/json")) {
    const jsonUrl = new URL(path + ".json", url);
    const jsonRes = await next(new Request(jsonUrl, request));
    res = jsonRes.status === 200 ? jsonRes : await next();
  } else {
    res = await next();
  }

  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.append("vary", "Accept");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};
