FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
ENV IP_FILE=/app/config/ip.txt \
    DATA_DIR=/app/data
COPY server.js ./server.js
COPY src ./src
COPY public ./public
RUN mkdir -p /app/config /app/data
EXPOSE 8787
CMD ["node", "server.js"]