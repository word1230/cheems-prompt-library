use chrono::Utc;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Clone)]
struct AppState {
  db_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptRecord {
  id: i64,
  title: String,
  content: String,
  tags: Vec<String>,
  is_favorite: bool,
  score_avg: f64,
  score_count: i64,
  created_at: String,
  updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptVersionRecord {
  id: i64,
  prompt_id: i64,
  content: String,
  change_note: String,
  created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TagInfo {
  name: String,
  count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePromptInput {
  id: Option<i64>,
  title: String,
  content: String,
  tags: Vec<String>,
  is_favorite: bool,
  change_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogUsageInput {
  prompt_id: i64,
  input_vars: Value,
  output_text: String,
  rating: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportVersionItem {
  content: String,
  change_note: String,
  created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPromptItem {
  title: String,
  content: String,
  tags: Vec<String>,
  is_favorite: bool,
  score_avg: f64,
  score_count: i64,
  versions: Vec<ExportVersionItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportPayload {
  exported_at: String,
  prompts: Vec<ExportPromptItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportVersionItem {
  content: String,
  change_note: Option<String>,
  created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportPromptItem {
  title: String,
  content: String,
  tags: Option<Vec<String>>,
  is_favorite: Option<bool>,
  score_avg: Option<f64>,
  score_count: Option<i64>,
  versions: Option<Vec<ImportVersionItem>>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ImportPayload {
  Wrapped { prompts: Vec<ImportPromptItem> },
  Flat(Vec<ImportPromptItem>),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
  imported: i64,
}

fn now_iso() -> String {
  Utc::now().to_rfc3339()
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut normalized = Vec::new();

  for tag in tags {
    let trimmed = tag.trim();
    if trimmed.is_empty() {
      continue;
    }
    let lower_key = trimmed.to_lowercase();
    if seen.insert(lower_key) {
      normalized.push(trimmed.to_string());
    }
  }

  normalized
}

fn encode_tags(tags: &[String]) -> String {
  serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

fn decode_tags(value: &str) -> Vec<String> {
  serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

fn open_connection(db_path: &Path) -> Result<Connection, String> {
  let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
  connection
    .execute("PRAGMA foreign_keys = ON", [])
    .map_err(|error| error.to_string())?;
  Ok(connection)
}

fn initialize_database(db_path: &Path) -> Result<(), String> {
  let connection = open_connection(db_path)?;
  connection
    .execute_batch(
      "
      CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        is_favorite INTEGER NOT NULL DEFAULT 0,
        score_avg REAL NOT NULL DEFAULT 0,
        score_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        change_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id INTEGER NOT NULL,
        input_vars TEXT NOT NULL DEFAULT '{}',
        output_text TEXT NOT NULL,
        rating INTEGER,
        used_at TEXT NOT NULL,
        FOREIGN KEY(prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_prompts_updated_at ON prompts(updated_at);
      CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt_id ON prompt_versions(prompt_id);
      CREATE INDEX IF NOT EXISTS idx_usage_logs_prompt_id ON usage_logs(prompt_id);
      ",
    )
    .map_err(|error| error.to_string())?;
  Ok(())
}

fn row_to_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptRecord> {
  let tags_raw: String = row.get(3)?;
  Ok(PromptRecord {
    id: row.get(0)?,
    title: row.get(1)?,
    content: row.get(2)?,
    tags: decode_tags(&tags_raw),
    is_favorite: row.get::<_, i64>(4)? == 1,
    score_avg: row.get(5)?,
    score_count: row.get(6)?,
    created_at: row.get(7)?,
    updated_at: row.get(8)?,
  })
}

fn fetch_prompt(connection: &Connection, prompt_id: i64) -> Result<Option<PromptRecord>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT id, title, content, tags, is_favorite, score_avg, score_count, created_at, updated_at
      FROM prompts
      WHERE id = ?1
      LIMIT 1
      ",
    )
    .map_err(|error| error.to_string())?;

  statement
    .query_row(params![prompt_id], row_to_prompt)
    .optional()
    .map_err(|error| error.to_string())
}

fn fetch_prompt_versions(
  connection: &Connection,
  prompt_id: i64,
) -> Result<Vec<PromptVersionRecord>, String> {
  let mut statement = connection
    .prepare(
      "
      SELECT id, prompt_id, content, change_note, created_at
      FROM prompt_versions
      WHERE prompt_id = ?1
      ORDER BY created_at DESC, id DESC
      ",
    )
    .map_err(|error| error.to_string())?;

  let rows = statement
    .query_map(params![prompt_id], |row| {
      Ok(PromptVersionRecord {
        id: row.get(0)?,
        prompt_id: row.get(1)?,
        content: row.get(2)?,
        change_note: row.get(3)?,
        created_at: row.get(4)?,
      })
    })
    .map_err(|error| error.to_string())?;

  let mut versions = Vec::new();
  for row in rows {
    versions.push(row.map_err(|error| error.to_string())?);
  }
  Ok(versions)
}

fn insert_prompt_version(
  connection: &Connection,
  prompt_id: i64,
  content: &str,
  change_note: &str,
  created_at: &str,
) -> Result<(), String> {
  connection
    .execute(
      "
      INSERT INTO prompt_versions (prompt_id, content, change_note, created_at)
      VALUES (?1, ?2, ?3, ?4)
      ",
      params![prompt_id, content, change_note, created_at],
    )
    .map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
fn list_prompts(
  state: tauri::State<'_, AppState>,
  search: Option<String>,
  tag: Option<String>,
  sort_by: Option<String>,
) -> Result<Vec<PromptRecord>, String> {
  let connection = open_connection(&state.db_path)?;
  let mut sql = String::from(
    "
    SELECT id, title, content, tags, is_favorite, score_avg, score_count, created_at, updated_at
    FROM prompts
    WHERE 1 = 1
    ",
  );
  let mut query_params: Vec<String> = Vec::new();

  if let Some(search_term) = search
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
  {
    sql.push_str(" AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)");
    let pattern = format!("%{search_term}%");
    query_params.push(pattern.clone());
    query_params.push(pattern.clone());
    query_params.push(pattern);
  }

  if let Some(tag_filter) = tag
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
  {
    sql.push_str(" AND tags LIKE ?");
    query_params.push(format!("%\"{tag_filter}\"%"));
  }

  let sort_clause = match sort_by.as_deref() {
    Some("score") => "score_avg DESC, updated_at DESC",
    Some("created") => "created_at DESC",
    _ => "updated_at DESC",
  };
  sql.push_str(" ORDER BY ");
  sql.push_str(sort_clause);

  let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
  let rows = statement
    .query_map(params_from_iter(query_params.iter()), row_to_prompt)
    .map_err(|error| error.to_string())?;

  let mut prompts = Vec::new();
  for row in rows {
    prompts.push(row.map_err(|error| error.to_string())?);
  }
  Ok(prompts)
}

#[tauri::command]
fn list_tags(state: tauri::State<'_, AppState>) -> Result<Vec<TagInfo>, String> {
  let connection = open_connection(&state.db_path)?;
  let mut statement = connection
    .prepare("SELECT tags FROM prompts")
    .map_err(|error| error.to_string())?;
  let rows = statement
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|error| error.to_string())?;

  let mut counts: BTreeMap<String, i64> = BTreeMap::new();
  for row in rows {
    let tags = decode_tags(&row.map_err(|error| error.to_string())?);
    for tag_name in tags {
      *counts.entry(tag_name).or_insert(0) += 1;
    }
  }

  let mut tag_items: Vec<TagInfo> = counts
    .into_iter()
    .map(|(name, count)| TagInfo { name, count })
    .collect();
  tag_items.sort_by(|left, right| {
    right
      .count
      .cmp(&left.count)
      .then_with(|| left.name.cmp(&right.name))
  });

  Ok(tag_items)
}

#[tauri::command]
fn get_prompt(state: tauri::State<'_, AppState>, id: i64) -> Result<Option<PromptRecord>, String> {
  let connection = open_connection(&state.db_path)?;
  fetch_prompt(&connection, id)
}

#[tauri::command]
fn list_prompt_versions(
  state: tauri::State<'_, AppState>,
  prompt_id: i64,
) -> Result<Vec<PromptVersionRecord>, String> {
  let connection = open_connection(&state.db_path)?;
  fetch_prompt_versions(&connection, prompt_id)
}

#[tauri::command]
fn upsert_prompt(
  state: tauri::State<'_, AppState>,
  input: SavePromptInput,
) -> Result<PromptRecord, String> {
  let SavePromptInput {
    id,
    title,
    content,
    tags,
    is_favorite,
    change_note,
  } = input;

  let normalized_title = title.trim().to_string();
  if normalized_title.is_empty() {
    return Err("标题不能为空".to_string());
  }
  if content.trim().is_empty() {
    return Err("Prompt 内容不能为空".to_string());
  }

  let normalized_tags = normalize_tags(tags);
  let tags_json = encode_tags(&normalized_tags);
  let note = change_note.unwrap_or_default().trim().to_string();
  let timestamp = now_iso();
  let connection = open_connection(&state.db_path)?;

  if let Some(prompt_id) = id {
    let previous_content = connection
      .query_row(
        "SELECT content FROM prompts WHERE id = ?1",
        params![prompt_id],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|error| error.to_string())?;

    let Some(old_content) = previous_content else {
      return Err("指定的 Prompt 不存在".to_string());
    };

    connection
      .execute(
        "
        UPDATE prompts
        SET title = ?1, content = ?2, tags = ?3, is_favorite = ?4, updated_at = ?5
        WHERE id = ?6
        ",
        params![
          normalized_title,
          &content,
          tags_json,
          if is_favorite { 1 } else { 0 },
          timestamp,
          prompt_id
        ],
      )
      .map_err(|error| error.to_string())?;

    if old_content != content || !note.is_empty() {
      let version_note = if note.is_empty() {
        "content updated".to_string()
      } else {
        note.clone()
      };
      insert_prompt_version(&connection, prompt_id, &content, &version_note, &timestamp)?;
    }

    return fetch_prompt(&connection, prompt_id)?
      .ok_or_else(|| "读取更新后的 Prompt 失败".to_string());
  }

  connection
    .execute(
      "
      INSERT INTO prompts (title, content, tags, is_favorite, score_avg, score_count, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ",
      params![
        normalized_title,
        &content,
        tags_json,
        if is_favorite { 1 } else { 0 },
        0.0_f64,
        0_i64,
        timestamp,
        timestamp
      ],
    )
    .map_err(|error| error.to_string())?;

  let prompt_id = connection.last_insert_rowid();
  let initial_note = if note.is_empty() {
    "initial version".to_string()
  } else {
    note
  };
  insert_prompt_version(&connection, prompt_id, &content, &initial_note, &timestamp)?;

  fetch_prompt(&connection, prompt_id)?.ok_or_else(|| "读取新建 Prompt 失败".to_string())
}

#[tauri::command]
fn delete_prompt(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
  let connection = open_connection(&state.db_path)?;
  connection
    .execute("DELETE FROM prompts WHERE id = ?1", params![id])
    .map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
fn log_prompt_usage(state: tauri::State<'_, AppState>, input: LogUsageInput) -> Result<(), String> {
  if let Some(score) = input.rating {
    if !(1..=5).contains(&score) {
      return Err("评分范围必须在 1 到 5 之间".to_string());
    }
  }

  let connection = open_connection(&state.db_path)?;
  let now = now_iso();
  let input_vars_json = serde_json::to_string(&input.input_vars).map_err(|error| error.to_string())?;

  connection
    .execute(
      "
      INSERT INTO usage_logs (prompt_id, input_vars, output_text, rating, used_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ",
      params![input.prompt_id, input_vars_json, input.output_text, input.rating, now],
    )
    .map_err(|error| error.to_string())?;

  if let Some(score) = input.rating {
    let score_state = connection
      .query_row(
        "SELECT score_avg, score_count FROM prompts WHERE id = ?1",
        params![input.prompt_id],
        |row| Ok((row.get::<_, f64>(0)?, row.get::<_, i64>(1)?)),
      )
      .optional()
      .map_err(|error| error.to_string())?;

    let Some((score_avg, score_count)) = score_state else {
      return Err("记录使用日志失败：Prompt 不存在".to_string());
    };

    let next_count = score_count + 1;
    let next_avg = ((score_avg * score_count as f64) + score as f64) / next_count as f64;
    connection
      .execute(
        "
        UPDATE prompts
        SET score_avg = ?1, score_count = ?2, updated_at = ?3
        WHERE id = ?4
        ",
        params![next_avg, next_count, now_iso(), input.prompt_id],
      )
      .map_err(|error| error.to_string())?;
  }

  Ok(())
}

#[tauri::command]
fn export_prompts_json(state: tauri::State<'_, AppState>) -> Result<String, String> {
  let connection = open_connection(&state.db_path)?;
  let mut statement = connection
    .prepare(
      "
      SELECT id, title, content, tags, is_favorite, score_avg, score_count, created_at, updated_at
      FROM prompts
      ORDER BY updated_at DESC
      ",
    )
    .map_err(|error| error.to_string())?;

  let rows = statement
    .query_map([], row_to_prompt)
    .map_err(|error| error.to_string())?;

  let mut export_prompts = Vec::new();
  for row in rows {
    let prompt = row.map_err(|error| error.to_string())?;
    let versions = fetch_prompt_versions(&connection, prompt.id)?
      .into_iter()
      .map(|version| ExportVersionItem {
        content: version.content,
        change_note: version.change_note,
        created_at: version.created_at,
      })
      .collect::<Vec<_>>();

    export_prompts.push(ExportPromptItem {
      title: prompt.title,
      content: prompt.content,
      tags: prompt.tags,
      is_favorite: prompt.is_favorite,
      score_avg: prompt.score_avg,
      score_count: prompt.score_count,
      versions,
    });
  }

  let payload = ExportPayload {
    exported_at: now_iso(),
    prompts: export_prompts,
  };
  serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())
}

#[tauri::command]
fn import_prompts_json(
  state: tauri::State<'_, AppState>,
  json_data: String,
) -> Result<ImportResult, String> {
  let parsed_payload: ImportPayload =
    serde_json::from_str(&json_data).map_err(|error| format!("JSON 解析失败: {error}"))?;

  let items = match parsed_payload {
    ImportPayload::Wrapped { prompts } => prompts,
    ImportPayload::Flat(prompts) => prompts,
  };

  let mut connection = open_connection(&state.db_path)?;
  let transaction = connection
    .transaction()
    .map_err(|error| error.to_string())?;

  let mut imported_count = 0_i64;

  for item in items {
    let ImportPromptItem {
      title,
      content,
      tags,
      is_favorite,
      score_avg,
      score_count,
      versions,
    } = item;

    let normalized_title = title.trim().to_string();
    if normalized_title.is_empty() || content.trim().is_empty() {
      continue;
    }

    let normalized_tags = normalize_tags(tags.unwrap_or_default());
    let tags_json = encode_tags(&normalized_tags);
    let created_at = now_iso();
    let score_count = score_count.unwrap_or(0).max(0);
    let score_avg = if score_count == 0 {
      0.0
    } else {
      score_avg.unwrap_or(0.0)
    };

    transaction
      .execute(
        "
        INSERT INTO prompts (title, content, tags, is_favorite, score_avg, score_count, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ",
        params![
          normalized_title,
          &content,
          tags_json,
          if is_favorite.unwrap_or(false) { 1 } else { 0 },
          score_avg,
          score_count,
          created_at,
          created_at
        ],
      )
      .map_err(|error| error.to_string())?;

    let prompt_id = transaction.last_insert_rowid();
    let mut inserted_version = false;
    if let Some(version_items) = versions {
      for version in version_items {
        if version.content.trim().is_empty() {
          continue;
        }
        transaction
          .execute(
            "
            INSERT INTO prompt_versions (prompt_id, content, change_note, created_at)
            VALUES (?1, ?2, ?3, ?4)
            ",
            params![
              prompt_id,
              version.content,
              version.change_note.unwrap_or_else(|| "imported version".to_string()),
              version.created_at.unwrap_or_else(now_iso)
            ],
          )
          .map_err(|error| error.to_string())?;
        inserted_version = true;
      }
    }

    if !inserted_version {
      transaction
        .execute(
          "
          INSERT INTO prompt_versions (prompt_id, content, change_note, created_at)
          VALUES (?1, ?2, ?3, ?4)
          ",
          params![prompt_id, &content, "imported", now_iso()],
        )
        .map_err(|error| error.to_string())?;
    }

    imported_count += 1;
  }

  transaction.commit().map_err(|error| error.to_string())?;
  Ok(ImportResult {
    imported: imported_count,
  })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let app_data_dir = app.path().app_data_dir()?;
      fs::create_dir_all(&app_data_dir)?;
      let db_path = app_data_dir.join("prompt-library.db");
      initialize_database(&db_path).map_err(std::io::Error::other)?;
      app.manage(AppState { db_path });

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      list_prompts,
      list_tags,
      get_prompt,
      list_prompt_versions,
      upsert_prompt,
      delete_prompt,
      log_prompt_usage,
      export_prompts_json,
      import_prompts_json
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
