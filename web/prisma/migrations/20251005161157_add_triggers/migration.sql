-- CreateTable
CREATE TABLE "Trigger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "weight" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Trigger_serverId_phrase_idx" ON "Trigger"("serverId", "phrase");

-- CreateIndex
CREATE INDEX "Trigger_serverId_label_idx" ON "Trigger"("serverId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Trigger_serverId_phrase_label_key" ON "Trigger"("serverId", "phrase", "label");
