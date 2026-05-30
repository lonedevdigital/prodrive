import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import { appConfig } from "./config";
import authRoutes from "./routes/auth";
import folderRoutes from "./routes/folders";
import fileRoutes from "./routes/files";
import publicRoutes from "./routes/public";

async function bootstrap() {
  const app = Fastify({
    logger: true,
    requestTimeout: appConfig.upload.requestTimeoutMs
  });

  const isDev = process.env.NODE_ENV !== "production";
  const allowedOrigins = new Set([
    appConfig.frontendOrigin,
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]);

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      if (isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        callback(null, true);
        return;
      }
      app.log.warn({ origin }, "CORS blocked origin");
      callback(new Error("Origin not allowed"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400
  });

  await app.register(cookie);
  await app.register(jwt, {
    secret: appConfig.jwtSecret,
    cookie: {
      cookieName: "drive_token",
      signed: false
    }
  });
  await app.register(multipart, {
    limits: {
      fileSize: appConfig.upload.maxFileSizeBytes
    }
  });

  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(folderRoutes, { prefix: "/api/folders" });
  await app.register(fileRoutes, { prefix: "/api/files" });
  await app.register(publicRoutes, { prefix: "/api/public" });

  await app.listen({
    port: appConfig.port,
    host: "0.0.0.0"
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
