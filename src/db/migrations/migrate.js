// src/db/migrate.js
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";

const DB_PATH = process.env.SQLITE_PATH || "./data.sqlite";

export function openDb() {
  return new sqlite3.Database(DB_PATH);
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
          const files = fs
            .readdirSync(migrationsDir)
            .filter((f) => f.endsWith(".sql"))
            .sort();

          db.all(`SELECT id FROM schema_migrations`, (err2, rows) => {
            if (err2) return reject(err2);
            const applied = new Set(rows.map((r) => r.id));

            const applyNext = (i) => {
              if (i >= files.length) return resolve();

              const file = files[i];
              if (applied.has(file)) return applyNext(i + 1);

              const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
              db.exec(sql, (err3) => {
                if (err3) return reject(err3);

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
