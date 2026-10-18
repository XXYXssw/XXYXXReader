#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p bin data/covers data/cache library notes

echo "==> [1/2] 同步 Go 模块依赖 (go mod tidy)..."
go mod tidy

echo "==> [2/2] 编译零 CGO 纯原生单二进制 (bin/xxyxx-reader)..."
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/xxyxx-reader ./cmd/xxyxx-reader

echo "==> 编译完成！"
ls -lh bin/xxyxx-reader
echo "运行命令: ./bin/xxyxx-reader -config ./config.json"
