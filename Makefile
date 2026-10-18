.PHONY: all build run clean test tidy

BINARY_NAME=bin/xxyxx-reader
CMD_PATH=./cmd/xxyxx-reader

all: build

tidy:
	go mod tidy

build: tidy
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BINARY_NAME) $(CMD_PATH)

run: build
	./$(BINARY_NAME) -config ./config.json

test:
	go test -v ./...

clean:
	rm -f $(BINARY_NAME)
