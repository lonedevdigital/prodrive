import type { FastifyPluginAsync, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";

const authCookieName = "drive_token";
const authCookieMaxAgeSeconds = 60 * 60 * 24 * 7;

const authSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const registerSchema = authSchema.extend({
  name: z.string().min(2)
});

const MAX_SERIALIZATION_RETRY = 3;

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(authCookieName, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: authCookieMaxAgeSeconds
  });
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid payload",
        errors: parsed.error.flatten()
      });
    }

    const { name, email, password } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 10);
    let user:
      | {
          id: string;
          name: string;
          email: string;
          role: "ADMIN" | "USER";
        }
      | null = null;

    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRY; attempt += 1) {
      try {
        user = await prisma.$transaction(
          async (tx) => {
            const usersCount = await tx.user.count();
            const role = usersCount === 0 ? "ADMIN" : "USER";

            return tx.user.create({
              data: {
                name,
                email,
                passwordHash,
                role
              },
              select: {
                id: true,
                name: true,
                email: true,
                role: true
              }
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
          }
        );
        break;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          return reply.code(409).send({ message: "Email already registered" });
        }

        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034" &&
          attempt < MAX_SERIALIZATION_RETRY - 1
        ) {
          continue;
        }

        throw error;
      }
    }

    if (!user) {
      return reply.code(500).send({
        message: "Failed to register user. Please retry."
      });
    }

    const token = fastify.jwt.sign({ userId: user.id, email: user.email });
    setSessionCookie(reply, token);

    return {
      message: "Registered",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    };
  });

  fastify.post("/login", async (request, reply) => {
    const parsed = authSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid payload",
        errors: parsed.error.flatten()
      });
    }

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }

    const token = fastify.jwt.sign({ userId: user.id, email: user.email });
    setSessionCookie(reply, token);

    return {
      message: "Logged in",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    };
  });

  fastify.post("/logout", async (_request, reply) => {
    reply.clearCookie(authCookieName, { path: "/" });
    return { message: "Logged out" };
  });

  fastify.get(
    "/me",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.user.userId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true
        }
      });

      if (!user) {
        return reply.code(404).send({ message: "User not found" });
      }

      return { user };
    }
  );

  fastify.patch(
    "/profile",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = z
        .object({ name: z.string().min(2).max(100) })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid payload" });
      }
      const updated = await prisma.user.update({
        where: { id: request.user.userId },
        data: { name: parsed.data.name },
        select: { id: true, name: true, email: true, role: true }
      });
      return { user: updated };
    }
  );

  fastify.post(
    "/change-password",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = z
        .object({
          oldPassword: z.string().min(1),
          newPassword: z.string().min(6)
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid payload" });
      }
      const user = await prisma.user.findUnique({
        where: { id: request.user.userId }
      });
      if (!user) return reply.code(404).send({ message: "User not found" });
      const valid = await bcrypt.compare(parsed.data.oldPassword, user.passwordHash);
      if (!valid) return reply.code(401).send({ message: "Password lama salah" });
      const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
      return { message: "Password berhasil diubah" };
    }
  );
};

export default authRoutes;
