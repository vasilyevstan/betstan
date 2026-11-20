FROM docker.io/library/node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
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