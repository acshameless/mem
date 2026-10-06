CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts_seg USING fts5(
  text_seg,
  content='turns',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS turns_seg_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts_seg(rowid, text_seg) VALUES (new.id, COALESCE(new.text_seg, ''));
END;
CREATE TRIGGER IF NOT EXISTS turns_seg_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts_seg(turns_fts_seg, rowid, text_seg) VALUES ('delete', old.id, COALESCE(old.text_seg, ''));
END;
CREATE TRIGGER IF NOT EXISTS turns_seg_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts_seg(turns_fts_seg, rowid, text_seg) VALUES ('delete', old.id, COALESCE(old.text_seg, ''));
  INSERT INTO turns_fts_seg(rowid, text_seg) VALUES (new.id, COALESCE(new.text_seg, ''));
END;
