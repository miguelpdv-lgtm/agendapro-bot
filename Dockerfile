# La versión de la imagen DEBE coincidir con la versión de "playwright"
# fijada en package.json (1.48.2). Si subes una, sube la otra.
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
