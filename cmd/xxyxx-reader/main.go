package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"xxyxx-reader/internal/config"
	"xxyxx-reader/internal/db"
	"xxyxx-reader/internal/scanner"
	"xxyxx-reader/internal/server"
)

func main() {
	configPath := flag.String("config", "./config.json", "Path to config.json")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("[xxyxx-reader] failed to load config: %v", err)
	}

	store, err := db.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("[xxyxx-reader] failed to open database: %v", err)
	}
	defer store.Close()

	sc := scanner.New(cfg, store)
	scanned, err := sc.ScanAll()
	if err != nil {
		log.Printf("[xxyxx-reader] initial library scan warning: %v", err)
	} else {
		log.Printf("[xxyxx-reader] initial library scan completed (%d books indexed)", scanned)
	}

	if err := sc.StartWatcher(); err != nil {
		log.Printf("[xxyxx-reader] fsnotify watcher warning: %v", err)
	}
	defer sc.Stop()

	srv := server.New(cfg, store, sc)
	addr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.Port)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("=========================================================")
		log.Printf("  XXYXXReader v2 · 阅境 已启动")
		log.Printf("  水墨书架: http://127.0.0.1:%d/", cfg.Port)
		log.Printf("  OPDS目录: http://127.0.0.1:%d/opds", cfg.Port)
		log.Printf("  书库目录: %s", cfg.LibraryDir)
		log.Printf("  笔记目录: %s", cfg.NotesDir)
		log.Printf("=========================================================")
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[xxyxx-reader] server listen error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Printf("[xxyxx-reader] shutting down gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}
