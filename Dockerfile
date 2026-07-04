FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV SERVE_STATIC=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
