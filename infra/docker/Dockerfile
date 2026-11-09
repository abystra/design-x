FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS service
ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
USER node
EXPOSE 3001
CMD ["node","--import","tsx","apps/api/src/main.ts"]

FROM base AS renderer
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm exec playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
USER node
CMD ["node","--import","tsx","apps/renderer/src/main.ts"]

FROM nginx:1.27-alpine AS web
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=base /app/dist /usr/share/nginx/html
EXPOSE 80
