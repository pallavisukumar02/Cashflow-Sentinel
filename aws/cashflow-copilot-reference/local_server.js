
import http from "node:http";
import { handler } from "./index.js";

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  // Serve the chatbot page.
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
    });

    const { readFile } = await import("node:fs/promises");
    const html = await readFile(
      new URL("./index.html", import.meta.url)
    );

    res.end(html);
    return;
  }

  // Handle browser preflight requests.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    res.end();
    return;
  }

  // Send chatbot questions to the existing backend.
  if (req.method === "POST" && req.url === "/api/chat") {
    try {
      let rawBody = "";

      for await (const chunk of req) {
        rawBody += chunk;

        if (rawBody.length > 1_000_000) {
          res.writeHead(413, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ error: "Request too large." }));
          return;
        }
      }

      const body = JSON.parse(rawBody || "{}");

      const result = await handler({
        httpMethod: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      res.writeHead(result.statusCode || 500, {
        ...result.headers,
        "Access-Control-Allow-Origin": "*",
      });

      res.end(result.body || "{}");
    } catch (error) {
      console.error("Local server error:", error);

      res.writeHead(400, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });

      res.end(
        JSON.stringify({
          error: "Could not process the request. Check the terminal.",
        })
      );
    }

    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Route not found." }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Cashflow Sentinel running at http://127.0.0.1:${PORT}`);
  console.log("Chat endpoint: POST /api/chat");
});
