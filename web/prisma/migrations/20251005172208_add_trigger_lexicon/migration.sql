/*
  Warnings:

  - You are about to drop the column `count` on the `Trigger` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Trigger` table. All the data in the column will be lost.
  - Added the required column `pattern` to the `Trigger` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Trigger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT,
    "phrase" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Trigger" ("createdAt", "id", "label", "phrase", "serverId", "weight") SELECT "createdAt", "id", "label", "phrase", "serverId", coalesce("weight", 1) AS "weight" FROM "Trigger";
DROP TABLE "Trigger";
ALTER TABLE "new_Trigger" RENAME TO "Trigger";
CREATE INDEX "Trigger_serverId_channelId_idx" ON "Trigger"("serverId", "channelId");
CREATE INDEX "Trigger_label_idx" ON "Trigger"("label");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
