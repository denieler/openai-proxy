FROM denoland/deno:2.4.5 AS runtime

WORKDIR /app

COPY deno.json ./
COPY src ./src

RUN deno cache src/main.ts

USER deno

EXPOSE 8080

CMD ["run", "--allow-env", "--allow-net", "src/main.ts"]
