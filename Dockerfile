FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY server.js ./server.js
COPY public ./public
RUN mkdir -p /app/config /app/data
EXPOSE 8787
CMD ["node", "server.js"]