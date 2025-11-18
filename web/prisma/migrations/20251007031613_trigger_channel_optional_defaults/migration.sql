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
    "weight" REAL NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Trigger" ("channelId", "createdAt", "hits", "id", "label", "pattern", "phrase", "serverId", "weight") SELECT "channelId", "createdAt", coalesce("hits", 0) AS "hits", "id", "label", "pattern", "phrase", "serverId", coalesce("weight", 1) AS "weight" FROM "Trigger";
DROP TABLE "Trigger";
ALTER TABLE "new_Trigger" RENAME TO "Trigger";
CREATE INDEX "Trigger_serverId_idx" ON "Trigger"("serverId");
CREATE UNIQUE INDEX "Trigger_serverId_phrase_label_key" ON "Trigger"("serverId", "phrase", "label");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Label_messageId_idx" ON "Label"("messageId");

-- CreateIndex
CREATE INDEX "Label_createdAt_idx" ON "Label"("createdAt");

-- CreateIndex
CREATE INDEX "Message_serverId_createdAt_idx" ON "Message"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_serverId_channelId_createdAt_idx" ON "Message"("serverId", "channelId", "createdAt");
