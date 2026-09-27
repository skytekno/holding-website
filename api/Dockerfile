FROM rust:1.95-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --locked --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sky && useradd --uid 10001 --gid sky --no-create-home sky \
    && mkdir -p /app/assets && chown sky:sky /app/assets
COPY --from=builder /app/target/release/sky-holding-api /usr/local/bin/sky-holding-api
WORKDIR /app
USER 10001:10001
ENV PORT=8080 LOCAL_ASSET_PATH=/app/assets
EXPOSE 8080
ENTRYPOINT ["sky-holding-api"]
