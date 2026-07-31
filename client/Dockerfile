FROM node:20-alpine AS build
ENV CI=true
WORKDIR /usr/app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.30.4-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=nginx:nginx /usr/app/build /usr/share/nginx/html
USER nginx
RUN nginx -t
EXPOSE 3000
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]