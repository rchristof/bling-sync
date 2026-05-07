FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --include=dev

COPY --chown=node:node . .

RUN npm run build
RUN npm prune --omit=dev
RUN mkdir -p /app/logs && chown node:node /app/logs

USER node

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
