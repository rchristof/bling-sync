FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

RUN mkdir -p /app/logs && chown node:node /app/logs

USER node

EXPOSE 3000

CMD ["node", "server.js"]
