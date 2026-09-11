# ---- build ----
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Descarta as devDependencies antes de copiar para a imagem final.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# O Cloud Run injeta PORT; 8080 é só o padrão local.
ENV PORT=8080
EXPOSE 8080

# Nada aqui precisa de root.
USER node

CMD ["node", "dist/index.js"]
