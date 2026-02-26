// src/db/migrate.js
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";

const DB_PATH = process.env.SQLITE_PATH || "./data.sqlite";

function ensureDirForDbFile(dbPath) {
  // если путь типа "./data/data.sqlite" — создаём папку "./data"
  const dir = path.dirname(dbPath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function openDb() {
  ensureDirForDbFile(DB_PATH);

  const db = new sqlite3.Database(DB_PATH);

  // ВАЖНО: включить foreign keys (SQLite по умолчанию может быть OFF)
  db.exec("PRAGMA foreign_keys = ON;");

  // немного полезных прагм для стабильности (не обязательны, но обычно помогают)
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  return db;
}

export function runMigrations(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at_utc TEXT NOT NULL
        );`,
        (err) => {
          if (err) return reject(err);

          const migrationsDir = path.join(process.cwd(), "src", "db", "migrations");
          console.log("SQLite DB_PATH =", DB_PATH);
          console.log("Migrations dir =", migrationsDir);

          if (!fs.existsSync(migrationsDir)) {
            return reject(new Error(`Migrations dir not found: ${migrationsDir}`));
          }

          const files = fs
            .readdirSync(migrationsDir)
            .filter((f) => f.endsWith(".sql"))
            .sort();

          db.all(`SELECT id FROM schema_migrations`, (err2, rows) => {
            if (err2) return reject(err2);

            const applied = new Set((rows || []).map((r) => r.id));

            const applyNext = (i) => {
              if (i >= files.length) return resolve();

              const file = files[i];
              if (applied.has(file)) return applyNext(i + 1);

              const fullPath = path.join(migrationsDir, file);
              const sql = fs.readFileSync(fullPath, "utf8").trim();

              // Атомарное применение миграции
              const wrapped = `BEGIN;\n${sql}\nCOMMIT;`;

              db.exec(wrapped, (err3) => {
                if (err3) {
                  // Откатываем транзакцию на ошибке
                  return db.exec("ROLLBACK;", () => reject(err3));
                }

                const now = new Date().toISOString();
                db.run(
                  `INSERT INTO schema_migrations (id, applied_at_utc) VALUES (?, ?)`,
                  [file, now],
                  (err4) => {
                    if (err4) return reject(err4);
                    console.log("Applied migration:", file);
                    applyNext(i + 1);
                  }
                );
              });
            };

            applyNext(0);
          });
        }
      );
    });
  });
}
