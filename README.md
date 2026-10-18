# XXYXXReader · 阅境

> **东方水墨宣纸美学 · 全设备响应式与墨水屏深度调优 · 物理文件夹分类双向同步 · 划线直写 Obsidian · 纯 Go 零 CGO 单二进制阅读服务**

## 核心特性

1. **微内核极致轻量**：纯 Go (`modernc.org/sqlite`) 编写，零 CGO、零外部依赖，前端静态资源与阅读内核通过 `//go:embed` 完全内嵌为单一可执行文件。
2. **四套水墨与电子纸主题**：内置 **宣纸墨香 (`rice-paper`)**、**墨水屏纯黑白 (`e-ink`)**、**现代素白 (`modern-white`)** 与 **水墨暗夜 (`dark-ink`)**，采用 128×128 低开销平铺 SVG 纸纹与章节 `iframe` 样式穿透注入。
3. **文件夹即分类（物理双向同步）**：
   - 本地 `library/` 下的一级子目录自动映射为书架分类；
   - Web 端新建、重命名、删除分类或调整书籍分类时，自动同步执行物理目录重命名与文件移动；
   - 基于快速文件指纹（`file_hash`：头尾 64KB + 文件大小 SHA-256）识别书籍，Finder 中移动或改名文件**绝不丢失阅读进度与划线批注**；
   - 自动过滤 macOS `.DS_Store` 与 `._*` AppleDouble 隐藏文件，支持 `fsnotify` 500ms 防抖监听。
4. **全格式统一流式内核 (`Foliate-core`)**：
   - 原生支持 `EPUB`、`AZW3 / MOBI`、`Markdown (.md)`、`TXT`（自动探测 UTF-8 / GB18030 / Big5 编码并正则智能切章）；
   - MD / TXT / MOBI 自动生成落盘虚拟 EPUB 缓存（`data/cache/`），配合 `HTTP 206 Range` 分片传输，杜绝大体积书籍撑爆内存；
   - 入库自动提取并缓存书籍封面（`data/covers/`），无封面书籍自动渲染古籍线装矢量封套。
5. **墨水屏第一公民与三模翻页**：
   - 支持 **点按瞬切 (0ms 无残影)**、**水平滑动 (220ms)**、**连续滚动** 三种翻页模式；
   - **二维九宫格触控热区**：中心矩形 `[X: 30%~70%, Y: 25%~75%]` 呼出菜单，其余区域按 `X < 35%` 上一页、`X >= 35%` 下一页分配；
   - **自定义物理翻页键录制**：支持一键录制绑定文石、掌阅、汉王等各品牌墨水屏实体翻页键与音量键。
6. **四色文人印彩与 Obsidian 幂等同步**：
   - 支持 **朱砂、竹青、松烟、秋葵** 四色划线与心得批注，采用 `CFI + 前后文锚点` 双重定位；
   - 实时写入 `notes/《书名》.md`，采用 `<!-- XXYXX_ANNOTATIONS_START/END -->` 受管区块幂等更新与 `.tmp` 原子替换，完整保留用户在 Obsidian 中手写的长评与批注。
7. **标准 OPDS 1.2 协议支持**：提供 `/opds` 与 `/opds/books` 端点，供 KOReader 等外部阅读器直接浏览分类与离线下载。

## 快速开始

### 1. 编译与启动

在 macOS (Apple Silicon / Intel) 或 Linux 环境下（需安装 Go 1.22+）：

```bash
chmod +x build.sh
./build.sh
./bin/xxyxx-reader -config ./config.json
```

或使用 `Makefile`：

```bash
make build
make run
```

启动后浏览器访问：`http://127.0.0.1:8980`

### 2. ServiceHub 注册（macOS）

```bash
hubctl register ./servicehub.json
hubctl start xxyxx-reader
```
