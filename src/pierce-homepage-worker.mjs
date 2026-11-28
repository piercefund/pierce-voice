const homepagePaths = new Set([
  "/",
  "/pierce-homepage/styles.css",
  "/pierce-homepage/favicon-32.png",
  "/pierce-homepage/copy.js"
]);

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && homepagePaths.has(pathname)) {
      return env.HOMEPAGE.fetch(request);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const legacy = new URL("https://legacy.pierce.fund");
    legacy.pathname = pathname;
    legacy.search = new URL(request.url).search;
    return Response.redirect(legacy, 302);
  }
};
