# PhoneMic 自托管中继。构建上下文 = 仓库根：
#   docker build -f relay-server/Dockerfile -t phonemic-relay .
# 国内网络（crates.io 访问慢/不通）加：--build-arg RS_PROXY=1
FROM rust:1.87-slim AS build
ARG RS_PROXY=""
# 可选：字节 rsproxy 镜像源
RUN if [ -n "$RS_PROXY" ]; then \
        mkdir -p /usr/local/cargo && \
        printf '[source.crates-io]\nreplace-with = "rsproxy-sparse"\n\n[source.rsproxy-sparse]\nregistry = "sparse+https://rsproxy.cn/index/"\n' \
            >> /usr/local/cargo/config.toml; \
    fi
WORKDIR /app
COPY relay-server/Cargo.toml ./Cargo.toml
COPY relay-server/src ./src
# 手机页（中继托管，扫码后的落地页）；rust-embed 的 ../phone/dist → /phone/dist
COPY phone/dist /phone/dist
RUN cargo build --release --bin phonemic-relay

FROM debian:bookworm-slim AS run
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/phonemic-relay /usr/local/bin/phonemic-relay
ENV LISTEN=0.0.0.0:9430
EXPOSE 9430
USER nobody
CMD ["phonemic-relay"]
