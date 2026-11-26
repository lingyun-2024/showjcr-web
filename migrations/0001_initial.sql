CREATE TABLE deadline_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT,
    etag TEXT,
    last_modified TEXT,
    last_success INTEGER,
    last_attempt INTEGER,
    result TEXT
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    github_id TEXT NOT NULL,
    login TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE favorites (
    github_id TEXT NOT NULL,
    venue_id TEXT NOT NULL,
    edition_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (github_id, venue_id, edition_id)
);
