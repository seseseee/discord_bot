-- DropIndex
DROP INDEX "Feedback_serverId_channelId_idx";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Trigger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT,
    "phrase" TEXT NOT NULL,
    "pattern" TEXT,
    "label" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "weight" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Trigger" ("channelId", "createdAt", "hits", "id", "label", "pattern", "phrase", "serverId", "weight") SELECT "channelId", "createdAt", "hits", "id", "label", "pattern", "phrase", "serverId", "weight" FROM "Trigger";
DROP TABLE "Trigger";
ALTER TABLE "new_Trigger" RENAME TO "Trigger";
CREATE INDEX "Trigger_serverId_phrase_idx" ON "Trigger"("serverId", "phrase");
CREATE UNIQUE INDEX "Trigger_serverId_phrase_label_key" ON "Trigger"("serverId", "phrase", "label");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
