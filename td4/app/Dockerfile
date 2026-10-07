FROM node:24-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS dev
RUN npm ci
COPY src ./src
CMD ["npm", "run", "dev"]

FROM base AS prod
RUN --mount=type=secret,id=token \
    echo "téléchargement avec le jeton $(cat /run/secrets/token)"
RUN npm ci --omit=dev
COPY src ./src
USER node
CMD ["node", "src/server.js"]
