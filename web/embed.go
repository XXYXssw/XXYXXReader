package web

import "embed"

// DistFS 内嵌前端构建产物 (index.html, reader.html, css/*, js/*)
//
//go:embed all:dist
var DistFS embed.FS
