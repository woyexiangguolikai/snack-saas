# 多租户服务端镜像
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/tokens/package.json ./packages/tokens/
COPY apps/server/package.json ./apps/server/
RUN npm install --no-audit --no-fund

COPY packages/tokens ./packages/tokens
COPY apps/server ./apps/server

# 先编 tokens 再编 server：共享包必须是**已构建产物**，
# 不能让服务端跨目录直接吃裸 TS —— 那需要 esbuild 之类的转译器，
# 而它们不产出 emitDecoratorMetadata，NestJS 的构造函数注入会静默失效。
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* ./
COPY packages/tokens/package.json ./packages/tokens/
COPY apps/server/package.json ./apps/server/
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/packages/tokens/dist ./packages/tokens/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY apps/server/prisma ./apps/server/prisma

EXPOSE 3000

# 健康检查走真实业务接口，而不是只看端口是否在听
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/main.js"]
