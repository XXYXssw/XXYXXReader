# XXYXXReader · 阅境 —— 极轻量现代阅读服务开发架构设计指南（修订完整版）

> **定位**：东方水墨宣纸美学 · 全设备响应式与墨水屏深度调优 · 物理文件夹分类双向同步 · 划线直写 Obsidian · 原生常驻仅约 15MB 内存的 Go 微内核阅读服务。

---

## 目录

- [一、 项目背景与设计哲学](#一-项目背景与设计哲学)
- [二、 整体技术架构与核心指标](#二-整体技术架构与核心指标)
- [三、 视觉美学与四套主题系统（致敬 9870 宣纸墨香）](#三-视觉美学与四套主题系统致敬-9870-宣纸墨香)
- [四、 书架体系与自定义分类（物理文件夹双向同步 + 文件指纹）](#四-书架体系与自定义分类物理文件夹双向同步--文件指纹)
- [五、 多格式流式解析引擎与阅读内核（Range 分片与虚拟 EPUB 缓存）](#五-多格式流式解析引擎与阅读内核range-分片与虚拟-epub-缓存)
- [六、 全设备适配与三模翻页引擎（二维九宫格热区与按键录制）](#六-全设备适配与三模翻页引擎二维九宫格热区与按键录制)
- [七、 划线批注与 Obsidian 受管区块幂等同步机制](#七-划线批注与-obsidian-受管区块幂等同步机制)
- [八、 数据库设计与持久化规范 (SQLite WAL + 外键约束)](#八-数据库设计与持久化规范-sqlite-wal--外键约束)
- [九、 后端 REST API 与 OPDS 协议端点](#九-后端-rest-api-与-opds-协议端点)
- [十、 项目目录结构规划](#十-项目目录结构规划)
- [十一、 macOS 部署、ServiceHub 状态栏托管与 Tailscale 远程访问](#十一-macos-部署servicehub-状态栏托管与-tailscale-远程访问)

---

## 一、 项目背景与设计哲学

在自建电子书服务生态中，常见方案如 Calibre、Kavita、Audiobookshelf 等功能虽然丰富，但在个人阅读场景下往往面临三大痛点：
1. **资源笨重**：基于 Python/C#/.NET 或 Java 运行时，常驻内存通常在 200MB~800MB 之间，且依赖庞大的容器环境；
2. **墨水屏体验恶劣**：富前端界面充斥着连续滚动动画、半透明模糊与低对比度灰阶，在电子纸设备上造成严重的眩光与残影撕裂；
3. **笔记孤岛**：书籍高亮与思考笔记难以自动化、结构化地沉淀回本地 Markdown 知识库（如 Obsidian）。

**XXYXXReader** 针对上述问题而设计，确立了以下核心原则：
- **微内核极致轻量**：采用纯 Go (`modernc.org/sqlite`) 编写单二进制文件，静态资源完全嵌入，零 CGO、零外部依赖，Mac 原生常驻内存压制在 **10MB ~ 20MB**。
- **文人雅致审美**：汲取东方典籍排版精髓（参考本地服务 `http://127.0.0.1:9870`），以宣纸色与水墨浓淡为基调，搭配低 GPU 开销的平铺纸纹。
- **墨水屏第一公民**：提供 0ms 瞬切无残影的点按翻页、自定义实体按键录制绑定与纯白纯黑 E-Ink 模式；同时自适应兼容手机、平板与桌面。
- **本地文件夹双向同步**：本地书库目录以“一级子文件夹即分类”作为单一事实来源（SSOT），支持 Finder 与 Web 端双向操作与文件指纹识别。
- **双模访问**：自带现代化 Web 端阅读器，同时提供轻量 OPDS 1.2 协议，供外部原生阅读器（如 KOReader）随时离线拉取。

---

## 二、 整体技术架构与核心指标

### 关键运行指标
- **单二进制大小**：约 18MB ~ 28MB（内含前端静态文件与自包含 Foliate-core 内核）。
- **常驻内存**：空闲时约 **12MB**，阅读翻页时峰值 **< 25MB**（依托 `http.ServeContent` Range 分片与落盘虚拟 EPUB 缓存）。
- **启动时间**：< 15ms（毫秒级冷启）。
- **外部依赖**：无（零 Docker、零外部 C 库、零 Python/Node 运行时）。

---

## 三、 视觉美学与四套主题系统（致敬 9870 宣纸墨香）

### 1. 低开销平铺纸张质感层 (Tiled Texture Layer)
在宣纸主题下，采用 `160x160` 尺寸平铺的 SVG 分形噪声背景（`background-repeat: repeat`），避免在 4K/5K 大屏上全屏实时计算滤镜导致的掉帧，且在 `e-ink`、`modern-white`、`dark-ink` 主题下自动隐藏。

### 2. Shadow DOM 与章节 `iframe` 样式穿透
由于阅读器采用 Shadow DOM 与章节 `<iframe>` 渲染，当主题或排版五要素变更时，通过 `<foliate-view>` 的 `_applyIframeStyles()` 实时向 `iframe` 内部注入当前主题字色、背景色、字体栈、行高、页边距及墨水屏 `transition: none !important` 规则。

---

## 四、 书架体系与自定义分类（物理文件夹双向同步 + 文件指纹）

### 1. 物理目录驱动的单一事实来源（SSOT）
- **Web 端新建/重命名分类**：后端同步在 `library/` 下执行 `os.MkdirAll` 或 `os.Rename`，并更新分类下所有书籍的 `file_path`。
- **Web 端删除分类**：将该分类子文件夹内的书籍安全移回 `library/` 根目录（重置为未分类）后再移除空文件夹，**绝不误删物理书籍文件**。
- **Web 端调整书籍分类**：后端同步执行 `os.Rename` 将书籍文件移入目标分类子文件夹。

### 2. 快速文件指纹 (`file_hash`) 防笔记丢失
- 计算书籍 **文件大小 + 头部 64KB + 尾部 64KB 的 SHA-256** 作为 `file_hash`。
- 当用户在 Finder 中移动或重命名书籍文件时，Scanner 通过 `file_hash` 识别出原有书籍身份，仅更新 `file_path` 与 `category_id`，**100% 保留原有阅读进度与所有划线批注**。

### 3. macOS 外置磁盘防抖与隐藏文件过滤
- 严格过滤 `.DS_Store` 及 `._*`（AppleDouble 文件）。
- `fsnotify` 事件采用 **500ms 防抖（Debounce）**，并在检测到新建一级子目录时动态注册监听。

---

## 五、 多格式流式解析引擎与阅读内核（Range 分片与虚拟 EPUB 缓存）

- **EPUB / AZW3 / MOBI**：入库时自动提取元数据与封面图片并缓存至 `data/covers/{book_id}.jpg`（无封面时动态渲染古籍线装矢量 SVG 封套）；正文传输通过 `http.ServeContent` 原生支持 `HTTP 206 Range` 零拷贝流。
- **Markdown (.md) / TXT**：自动探测 UTF-8 / GB18030 / Big5 编码，按标题或章节正则智能切章，转换并落盘缓存为 `data/cache/{book_id}.epub`，阅读时直接按标准 EPUB 流式加载。

---

## 六、 全设备适配与三模翻页引擎（二维九宫格热区与按键录制）

- **二维九宫格触控热区**：
  - **中心矩形 `[X: 30%~70%, Y: 25%~75%]`**：点按呼出/收起顶部导航与底部进度栏；
  - **非中心区 `X < 35%`**：上一页；
  - **非中心区 `X >= 35%`**：下一页（扩大单手盲按热区，且与中央菜单区完全无冲突）。
- **墨水屏实体按键自定义录制**：内置“录制下页键 / 上页键”功能，捕获设备专属 `key` 与 `keyCode` 存入 `localStorage`，通吃文石、汉王、掌阅等各品牌墨水屏翻页键。

---

## 七、 划线批注与 Obsidian 受管区块幂等同步机制

- **双重定位锚点**：保存 `epubcfi(...)` 的同时记录 `selected_text`、`prefix_text`、`suffix_text`、`chapter_title` 与 `chapter_index`。
- **受管区块幂等更新**：在 `notes/《书名》.md` 中使用 `<!-- XXYXX_ANNOTATIONS_START -->` 与 `<!-- XXYXX_ANNOTATIONS_END -->` 界定自动同步区域。每次增删改批注时，按章节顺序重生成受管区块并更新 Frontmatter，**完整保留用户在受管区块之外手写的长评与思考**；写入采用 `.tmp` + `os.Rename` 原子替换。

---

## 八、 数据库设计与持久化规范 (SQLite WAL + 外键约束)

初始化连接时显式开启：
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```
并设置 `SetMaxOpenConns(1)`，彻底消除并发读写下的 `SQLITE_BUSY` 锁冲突。

---

## 九、 后端 REST API 与 OPDS 协议端点

- `GET /api/health` & `GET /api/config`：服务健康检查与运行状态（兼容 ServiceHub 轮询）。
- `POST /api/library/scan`：手动触发增量书库扫描。
- `GET/POST /api/categories`、`PUT/DELETE /api/categories/{id}`：分类与物理目录双向管理。
- `GET /api/books`、`POST /api/books/upload`、`GET/DELETE /api/books/{id}`、`POST /api/books/{id}/category`：藏书检索、上传、分类转移与移除。
- `GET /api/books/{id}/content`、`GET /api/books/{id}/cover`、`GET /api/books/{id}/download`：书籍流、封面缓存与原书下载。
- `POST /api/books/{id}/progress`、`GET/POST /api/books/{id}/annotations`、`DELETE /api/annotations/{id}`、`GET /api/books/{id}/notes`：阅读进度、四色朱批与 Obsidian 笔记同步。
- `GET /opds`、`GET /opds/books`：标准 OPDS 1.2 目录与书目订阅源。
