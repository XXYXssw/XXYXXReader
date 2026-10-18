package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config 定义服务运行时配置
type Config struct {
	Port       int    `json:"port"`
	Bind       string `json:"bind"`
	LibraryDir string `json:"library_dir"`
	NotesDir   string `json:"notes_dir"`
	DBPath     string `json:"db_path"`
	CacheDir   string `json:"cache_dir"`
	CoversDir  string `json:"covers_dir"`
}

// Default 返回默认配置
func Default() *Config {
	return &Config{
		Port:       8980,
		Bind:       "0.0.0.0",
		LibraryDir: "./library",
		NotesDir:   "./notes",
		DBPath:     "./data/reader.db",
		CacheDir:   "./data/cache",
		CoversDir:  "./data/covers",
	}
}

// Load 从指定 JSON 文件加载配置并确保必要目录存在
func Load(path string) (*Config, error) {
	cfg := Default()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, err
			}
		} else {
			if err := json.Unmarshal(data, cfg); err != nil {
				return nil, err
			}
		}
	}

	if cfg.CacheDir == "" {
		cfg.CacheDir = filepath.Join(filepath.Dir(cfg.DBPath), "cache")
	}
	if cfg.CoversDir == "" {
		cfg.CoversDir = filepath.Join(filepath.Dir(cfg.DBPath), "covers")
	}

	dirs := []string{
		cfg.LibraryDir,
		cfg.NotesDir,
		filepath.Dir(cfg.DBPath),
		cfg.CacheDir,
		cfg.CoversDir,
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return nil, err
		}
	}
	return cfg, nil
}
