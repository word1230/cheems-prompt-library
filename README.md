# Prompt Library Desktop MVP

本项目是一个离线优先的桌面 Prompt 管理工具（Tauri + React + SQLite）。

## 当前功能

- Prompt 新增、编辑、删除、收藏
- 标签分类、关键词搜索、排序（更新时间/评分/创建时间）
- 模板变量识别（`{{变量名}}`）与实时填充预览
- 一键复制并记录使用日志（支持 1-5 分评分）
- 版本历史保存与一键恢复
- JSON 导入与导出
- 快速面板（应用内 `Ctrl+K`）
- 系统级全局快捷键（默认 `Ctrl+Shift+K`，支持在界面中自定义并持久化）

## 技术栈

- 前端：React + TypeScript + Vite
- 桌面容器：Tauri v2
- 本地数据库：SQLite（rusqlite）

## 运行方式

先安装依赖：

```bash
npm install
```

仅启动 Web 开发环境：

```bash
npm run dev
```

启动桌面开发模式：

```bash
npm run tauri:dev
```

构建前端：

```bash
npm run build
```

构建桌面安装包：

```bash
npm run tauri:build
```

## 数据存储

- 数据库文件在系统应用数据目录下，文件名为 `prompt-library.db`
- 表结构包含：`prompts`、`prompt_versions`、`usage_logs`