import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type SortBy = "updated" | "score" | "created";

const DEFAULT_GLOBAL_SHORTCUT = "CommandOrControl+Shift+K";
const GLOBAL_SHORTCUT_EVENT = "global-shortcut-triggered";

type PromptRecord = {
  id: number;
  title: string;
  content: string;
  tags: string[];
  isFavorite: boolean;
  scoreAvg: number;
  scoreCount: number;
  createdAt: string;
  updatedAt: string;
};

type PromptVersionRecord = {
  id: number;
  promptId: number;
  content: string;
  changeNote: string;
  createdAt: string;
};

type TagInfo = {
  name: string;
  count: number;
};

type ImportResult = {
  imported: number;
};

type EditorState = {
  id: number | null;
  title: string;
  content: string;
  tagsText: string;
  isFavorite: boolean;
  changeNote: string;
};

const createEmptyEditorState = (): EditorState => ({
  id: null,
  title: "",
  content: "",
  tagsText: "",
  isFavorite: false,
  changeNote: "",
});

function parseTagInput(input: string): string[] {
  const unique = new Set<string>();
  const tags: string[] = [];

  for (const candidate of input.split(",")) {
    const cleaned = candidate.trim();
    if (!cleaned) {
      continue;
    }
    const key = cleaned.toLowerCase();
    if (unique.has(key)) {
      continue;
    }
    unique.add(key);
    tags.push(cleaned);
  }

  return tags;
}

function extractVariables(content: string): string[] {
  const variablePattern = /{{\s*([^{}]+?)\s*}}/g;
  const names = new Set<string>();

  let match = variablePattern.exec(content);
  while (match !== null) {
    const variableName = match[1]?.trim();
    if (variableName) {
      names.add(variableName);
    }
    match = variablePattern.exec(content);
  }

  return Array.from(names);
}

function applyVariables(content: string, values: Record<string, string>): string {
  return content.replace(/{{\s*([^{}]+?)\s*}}/g, (_, rawName: string) => {
    const variableName = rawName.trim();
    return values[variableName] ?? `{{${variableName}}}`;
  });
}

function summarizeContent(content: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 90) {
    return cleaned;
  }
  return `${cleaned.slice(0, 90)}...`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString("zh-CN", { hour12: false });
}

function formatShortcutForDisplay(shortcut: string): string {
  return shortcut
    .replace(/CommandOrControl/gi, "Ctrl")
    .replace(/CmdOrControl/gi, "Ctrl");
}

function App() {
  const [prompts, setPrompts] = useState<PromptRecord[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [versions, setVersions] = useState<PromptVersionRecord[]>([]);
  const [searchText, setSearchText] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("updated");
  const [editor, setEditor] = useState<EditorState>(createEmptyEditorState());
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [isVariablePanelOpen, setIsVariablePanelOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState("准备就绪");
  const [isSaving, setIsSaving] = useState(false);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteItems, setPaletteItems] = useState<PromptRecord[]>([]);
  const [globalShortcut, setGlobalShortcut] = useState(DEFAULT_GLOBAL_SHORTCUT);
  const [shortcutDraft, setShortcutDraft] = useState(DEFAULT_GLOBAL_SHORTCUT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isUpdatingShortcut, setIsUpdatingShortcut] = useState(false);

  const importInputRef = useRef<HTMLInputElement>(null);

  const variableNames = useMemo(() => extractVariables(editor.content), [editor.content]);
  const previewText = useMemo(
    () => applyVariables(editor.content, variableValues),
    [editor.content, variableValues],
  );
  const globalShortcutDisplay = useMemo(
    () => formatShortcutForDisplay(globalShortcut),
    [globalShortcut],
  );

  useEffect(() => {
    setVariableValues((current) => {
      const nextValues: Record<string, string> = {};
      for (const variableName of variableNames) {
        nextValues[variableName] = current[variableName] ?? "";
      }
      return nextValues;
    });
  }, [variableNames]);

  useEffect(() => {
    void invoke<string>("get_global_shortcut")
      .then((shortcut) => {
        setGlobalShortcut(shortcut);
        setShortcutDraft(shortcut);
      })
      .catch((error) => {
        setStatusMessage(`读取全局快捷键失败: ${String(error)}`);
      });
  }, []);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const [promptItems, tagItems] = await Promise.all([
            invoke<PromptRecord[]>("list_prompts", {
              search: searchText.trim() || null,
              tag: selectedTag || null,
              sortBy,
            }),
            invoke<TagInfo[]>("list_tags"),
          ]);

          setPrompts(promptItems);
          setTags(tagItems);

          if (editor.id !== null && !promptItems.some((item) => item.id === editor.id)) {
            setEditor(createEmptyEditorState());
            setVersions([]);
            setRating(null);
          }
        } catch (error) {
          setStatusMessage(`列表刷新失败: ${String(error)}`);
        }
      })();
    }, 120);

    return () => window.clearTimeout(refreshTimer);
  }, [searchText, selectedTag, sortBy, editor.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (isShortcut) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let isUnmounted = false;
    let unlisten: (() => void) | null = null;

    void listen(GLOBAL_SHORTCUT_EVENT, () => {
      setPaletteOpen(true);
      setPaletteQuery("");
      setStatusMessage(`已通过全局快捷键唤起（${globalShortcutDisplay}）`);
    })
      .then((fn) => {
        if (isUnmounted) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error) => {
        setStatusMessage(`全局快捷键监听失败: ${String(error)}`);
      });

    return () => {
      isUnmounted = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [globalShortcutDisplay]);

  useEffect(() => {
    if (!paletteOpen) {
      return;
    }

    const paletteTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await invoke<PromptRecord[]>("list_prompts", {
            search: paletteQuery.trim() || null,
            tag: null,
            sortBy: "updated",
          });
          setPaletteItems(result.slice(0, 12));
        } catch (error) {
          setStatusMessage(`快速面板查询失败: ${String(error)}`);
        }
      })();
    }, 100);

    return () => window.clearTimeout(paletteTimer);
  }, [paletteOpen, paletteQuery]);

  const selectPrompt = async (promptId: number) => {
    try {
      const [prompt, promptVersions] = await Promise.all([
        invoke<PromptRecord | null>("get_prompt", { id: promptId }),
        invoke<PromptVersionRecord[]>("list_prompt_versions", { promptId }),
      ]);

      if (!prompt) {
        setStatusMessage("该 Prompt 不存在或已被删除");
        return;
      }

      setEditor({
        id: prompt.id,
        title: prompt.title,
        content: prompt.content,
        tagsText: prompt.tags.join(", "),
        isFavorite: prompt.isFavorite,
        changeNote: "",
      });
      setVersions(promptVersions);
      setVariableValues({});
      setRating(null);
      setStatusMessage(`已加载：${prompt.title}`);
    } catch (error) {
      setStatusMessage(`读取详情失败: ${String(error)}`);
    }
  };

  const refreshListAndTags = async () => {
    const [promptItems, tagItems] = await Promise.all([
      invoke<PromptRecord[]>("list_prompts", {
        search: searchText.trim() || null,
        tag: selectedTag || null,
        sortBy,
      }),
      invoke<TagInfo[]>("list_tags"),
    ]);
    setPrompts(promptItems);
    setTags(tagItems);
  };

  const handleNewPrompt = () => {
    setEditor(createEmptyEditorState());
    setVersions([]);
    setVariableValues({});
    setRating(null);
    setStatusMessage("已切换到新建模式");
  };

  const handleSavePrompt = async () => {
    if (!editor.title.trim()) {
      setStatusMessage("请先填写标题");
      return;
    }
    if (!editor.content.trim()) {
      setStatusMessage("请先填写 Prompt 内容");
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        id: editor.id,
        title: editor.title,
        content: editor.content,
        tags: parseTagInput(editor.tagsText),
        isFavorite: editor.isFavorite,
        changeNote: editor.changeNote.trim() || null,
      };

      const savedPrompt = await invoke<PromptRecord>("upsert_prompt", { input: payload });
      await refreshListAndTags();
      await selectPrompt(savedPrompt.id);
      setStatusMessage("保存成功");
    } catch (error) {
      setStatusMessage(`保存失败: ${String(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeletePrompt = async () => {
    if (editor.id === null) {
      return;
    }
    const confirmed = window.confirm("确认删除这个 Prompt 吗？该操作不可恢复。");
    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    try {
      await invoke("delete_prompt", { id: editor.id });
      await refreshListAndTags();
      setEditor(createEmptyEditorState());
      setVersions([]);
      setVariableValues({});
      setRating(null);
      setStatusMessage("删除成功");
    } catch (error) {
      setStatusMessage(`删除失败: ${String(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleExport = async () => {
    try {
      const exportedJson = await invoke<string>("export_prompts_json");
      const blob = new Blob([exportedJson], { type: "application/json" });
      const blobUrl = URL.createObjectURL(blob);
      const downloadLink = document.createElement("a");
      downloadLink.href = blobUrl;
      downloadLink.download = `prompt-library-${Date.now()}.json`;
      downloadLink.click();
      URL.revokeObjectURL(blobUrl);
      setStatusMessage("已导出 JSON");
    } catch (error) {
      setStatusMessage(`导出失败: ${String(error)}`);
    }
  };

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) {
      return;
    }

    try {
      const jsonContent = await selectedFile.text();
      const importResult = await invoke<ImportResult>("import_prompts_json", {
        jsonData: jsonContent,
      });
      await refreshListAndTags();
      setStatusMessage(`导入完成，共 ${importResult.imported} 条`);
    } catch (error) {
      setStatusMessage(`导入失败: ${String(error)}`);
    } finally {
      event.target.value = "";
    }
  };

  const handleCopyAndLog = async () => {
    if (!previewText.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(previewText);

      if (editor.id !== null) {
        await invoke("log_prompt_usage", {
          input: {
            promptId: editor.id,
            inputVars: variableValues,
            outputText: previewText,
            rating,
          },
        });
      }

      await refreshListAndTags();
      setStatusMessage("已复制并记录使用日志");
    } catch (error) {
      setStatusMessage(`复制失败: ${String(error)}`);
    }
  };

  const handleApplyVersion = (version: PromptVersionRecord) => {
    setEditor((current) => ({
      ...current,
      content: version.content,
      changeNote: "恢复历史版本",
    }));
    setStatusMessage("已将历史版本内容写入编辑区，保存后会生成新版本");
  };

  const handlePickFromPalette = async (promptId: number) => {
    await selectPrompt(promptId);
    setPaletteOpen(false);
    setPaletteQuery("");
  };

  const handleSaveGlobalShortcut = async () => {
    const normalizedShortcut = shortcutDraft.trim();
    if (!normalizedShortcut) {
      setStatusMessage("请先填写全局快捷键");
      return;
    }

    setIsUpdatingShortcut(true);
    try {
      const savedShortcut = await invoke<string>("update_global_shortcut", {
        shortcut: normalizedShortcut,
      });
      setGlobalShortcut(savedShortcut);
      setShortcutDraft(savedShortcut);
      setSettingsOpen(false);
      setStatusMessage(`全局快捷键已更新为 ${formatShortcutForDisplay(savedShortcut)}`);
    } catch (error) {
      setStatusMessage(`更新全局快捷键失败: ${String(error)}`);
    } finally {
      setIsUpdatingShortcut(false);
    }
  };

  const handleResetGlobalShortcut = () => {
    setShortcutDraft(DEFAULT_GLOBAL_SHORTCUT);
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Prompt Library</h1>
          <p>离线桌面库 · 搜索、版本、变量填充与快速复制</p>
        </div>
        <div className="top-actions">
          <button className="ghost-button" onClick={() => setPaletteOpen(true)}>
            快速面板 Ctrl+K / 全局 {globalShortcutDisplay}
          </button>
          <button className="ghost-button" onClick={() => setSettingsOpen((current) => !current)}>
            快捷键设置
          </button>
          <button className="ghost-button" onClick={() => importInputRef.current?.click()}>
            导入 JSON
          </button>
          <button className="ghost-button" onClick={() => void handleExport()}>
            导出 JSON
          </button>
          <button className="primary-button" onClick={handleNewPrompt}>
            新建
          </button>
          <input
            ref={importInputRef}
            className="hidden-input"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void handleImportFileChange(event)}
          />
        </div>
      </header>

      {settingsOpen ? (
        <section className="shortcut-settings">
          <div className="shortcut-settings-title">系统级全局快捷键</div>
          <p className="shortcut-settings-help">
            使用格式例如 CommandOrControl+Shift+K、Alt+Space。保存后会立即生效并持久化。
          </p>
          <div className="shortcut-settings-row">
            <input
              className="shortcut-input"
              value={shortcutDraft}
              placeholder="例如 CommandOrControl+Shift+K"
              onChange={(event) => setShortcutDraft(event.target.value)}
            />
            <button
              className="ghost-button"
              onClick={handleResetGlobalShortcut}
              disabled={isUpdatingShortcut}
            >
              恢复默认
            </button>
            <button
              className="primary-button"
              onClick={() => void handleSaveGlobalShortcut()}
              disabled={isUpdatingShortcut}
            >
              {isUpdatingShortcut ? "保存中..." : "保存快捷键"}
            </button>
          </div>
          <div className="shortcut-settings-caption">当前生效：{globalShortcutDisplay}</div>
        </section>
      ) : null}

      <div className="workspace">
        <aside className="left-panel">
          <div className="filter-row">
            <input
              className="search-input"
              value={searchText}
              placeholder="搜索标题、内容、标签"
              onChange={(event) => setSearchText(event.target.value)}
            />
            <select
              className="sort-select"
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SortBy)}
            >
              <option value="updated">按最近更新</option>
              <option value="score">按评分</option>
              <option value="created">按创建时间</option>
            </select>
          </div>

          <div className="tag-strip">
            <button
              className={`tag-chip ${selectedTag === "" ? "active" : ""}`}
              onClick={() => setSelectedTag("")}
            >
              全部
            </button>
            {tags.map((tagItem) => (
              <button
                key={tagItem.name}
                className={`tag-chip ${selectedTag === tagItem.name ? "active" : ""}`}
                onClick={() => setSelectedTag(tagItem.name)}
              >
                {tagItem.name} ({tagItem.count})
              </button>
            ))}
          </div>

          <div className="panel-caption">
            当前筛选：{selectedTag || "全部"} · 共 {prompts.length} 条
          </div>

          <div className="prompt-list">
            {prompts.length === 0 ? (
              <div className="empty-state">暂无匹配 Prompt</div>
            ) : (
              prompts.map((prompt) => (
                <button
                  key={prompt.id}
                  className={`prompt-item ${editor.id === prompt.id ? "active" : ""}`}
                  onClick={() => void selectPrompt(prompt.id)}
                >
                  <div className="item-head">
                    <span className="item-title">{prompt.title}</span>
                    {prompt.isFavorite ? <span className="favorite-chip">收藏</span> : null}
                  </div>
                  <div className="item-snippet">{summarizeContent(prompt.content)}</div>
                  <div className="item-meta">
                    <span>{prompt.tags.slice(0, 3).join(" · ") || "未分类"}</span>
                    <span>
                      ⭐ {prompt.scoreCount > 0 ? prompt.scoreAvg.toFixed(1) : "-"}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="editor-panel">
          <div className="editor-row">
            <input
              className="title-input"
              value={editor.title}
              placeholder="请输入标题"
              onChange={(event) =>
                setEditor((current) => ({ ...current, title: event.target.value }))
              }
            />
            <label className="favorite-switch">
              <input
                type="checkbox"
                checked={editor.isFavorite}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, isFavorite: event.target.checked }))
                }
              />
              收藏
            </label>
          </div>

          <div className="editor-row split">
            <input
              value={editor.tagsText}
              placeholder="标签，使用逗号分隔"
              onChange={(event) =>
                setEditor((current) => ({ ...current, tagsText: event.target.value }))
              }
            />
            <input
              value={editor.changeNote}
              placeholder="本次修改说明（可选）"
              onChange={(event) =>
                setEditor((current) => ({ ...current, changeNote: event.target.value }))
              }
            />
          </div>

          <textarea
            className="content-editor"
            value={editor.content}
            placeholder="在这里输入 Prompt，可使用 {{变量名}}"
            onChange={(event) =>
              setEditor((current) => ({ ...current, content: event.target.value }))
            }
          />

          <div className="editor-actions">
            <button
              className="primary-button"
              onClick={() => void handleSavePrompt()}
              disabled={isSaving}
            >
              {isSaving ? "保存中..." : "保存"}
            </button>
            <button
              className="ghost-button"
              onClick={() => void handleCopyAndLog()}
              disabled={editor.id === null || !previewText.trim()}
            >
              复制当前 Prompt
            </button>
            <button className="ghost-button" onClick={handleNewPrompt} disabled={isSaving}>
              清空
            </button>
            <button
              className="danger-button"
              onClick={() => void handleDeletePrompt()}
              disabled={editor.id === null || isSaving}
            >
              删除
            </button>
          </div>

          <section className="panel-section">
            <div className="section-head">
              <div className="section-title">变量预览</div>
              <button
                className="ghost-button small"
                onClick={() => setIsVariablePanelOpen((current) => !current)}
                aria-expanded={isVariablePanelOpen}
              >
                {isVariablePanelOpen ? "收起" : "展开"}
              </button>
            </div>

            {isVariablePanelOpen ? (
              <>
                {variableNames.length === 0 ? (
                  <div className="empty-inline">当前未检测到变量，占位符格式为 {"{{变量名}}"}</div>
                ) : (
                  <div className="variable-grid">
                    {variableNames.map((variableName) => (
                      <label key={variableName} className="variable-item">
                        <span>{variableName}</span>
                        <input
                          value={variableValues[variableName] ?? ""}
                          onChange={(event) =>
                            setVariableValues((current) => ({
                              ...current,
                              [variableName]: event.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                )}

                <textarea className="preview-box" value={previewText} readOnly />

                <div className="preview-actions">
                  <label className="rating-field">
                    评分
                    <select
                      value={rating === null ? "" : String(rating)}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setRating(nextValue ? Number(nextValue) : null);
                      }}
                    >
                      <option value="">不评分</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                      <option value="5">5</option>
                    </select>
                  </label>
                  <button
                    className="primary-button"
                    onClick={() => void handleCopyAndLog()}
                    disabled={!previewText.trim()}
                  >
                    复制并记录
                  </button>
                </div>
              </>
            ) : (
              <div className="empty-inline">已折叠，展开后可填写变量并查看实时预览</div>
            )}
          </section>

          <section className="panel-section">
            <div className="section-title">版本历史</div>
            {versions.length === 0 ? (
              <div className="empty-inline">暂无版本记录</div>
            ) : (
              <div className="version-list">
                {versions.map((version) => (
                  <div className="version-item" key={version.id}>
                    <div className="version-meta">
                      <span>{formatDate(version.createdAt)}</span>
                      <span>{version.changeNote || "未填写说明"}</span>
                    </div>
                    <button
                      className="ghost-button small"
                      onClick={() => handleApplyVersion(version)}
                    >
                      恢复此版本
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      </div>

      <footer className="status-bar">{statusMessage}</footer>

      {paletteOpen ? (
        <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="palette" onClick={(event) => event.stopPropagation()}>
            <input
              className="palette-search"
              value={paletteQuery}
              placeholder="快速查找 Prompt"
              onChange={(event) => setPaletteQuery(event.target.value)}
              autoFocus
            />
            <div className="palette-list">
              {paletteItems.length === 0 ? (
                <div className="empty-state">没有匹配结果</div>
              ) : (
                paletteItems.map((item) => (
                  <button
                    key={item.id}
                    className="palette-item"
                    onClick={() => void handlePickFromPalette(item.id)}
                  >
                    <div className="item-head">
                      <span className="item-title">{item.title}</span>
                      {item.isFavorite ? <span className="favorite-chip">收藏</span> : null}
                    </div>
                    <div className="item-snippet">{summarizeContent(item.content)}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
