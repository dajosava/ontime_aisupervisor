FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY proxy-server.js index.html login.html auth.js app.js README.md supabase-schema.sql ./
COPY services ./services/
COPY agent ./agent/
COPY supervisor ./supervisor/
COPY config ./config/
COPY utils ./utils/
RUN mkdir -p /app/data
COPY images ./images/

ENV PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3001

CMD ["node", "proxy-server.js"]
