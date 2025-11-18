/*
  Warnings:

  - You are about to drop the column `rationale` on the `Feedback` table. All the data in the column will be lost.
  - You are about to drop the column `source` on the `Feedback` table. All the data in the column will be lost.
  - The primary key for the `Label` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `labelsJson` on the `Label` table. All the data in the column will be lost.
  - You are about to drop the column `reactionTo` on the `Label` table. All the data in the column will be lost.
  - You are about to drop the column `mentions` on the `Message` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "userId" TEXT,
    "label" TEXT NOT NULL,
    "confidence" REAL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Feedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Feedback" ("confidence", "createdAt", "id", "label", "messageId", "userId") SELECT "confidence", "createdAt", "id", "label", "messageId", "userId" FROM "Feedback";
DROP TABLE "Feedback";
ALTER TABLE "new_Feedback" RENAME TO "Feedback";
CREATE INDEX "Feedback_messageId_idx" ON "Feedback"("messageId");
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");
CREATE TABLE "new_Label" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "rationale" TEXT,
    "infoMentions" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Label_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Label" ("confidence", "createdAt", "id", "infoMentions", "label", "messageId", "rationale") SELECT "confidence", "createdAt", "id", "infoMentions", "label", "messageId", "rationale" FROM "Label";
DROP TABLE "Label";
ALTER TABLE "new_Label" RENAME TO "Label";
CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorIsBot" BOOLEAN NOT NULL,
    "contentText" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL
);
INSERT INTO "new_Message" ("authorId", "authorIsBot", "channelId", "contentText", "createdAt", "id", "serverId") SELECT "authorId", "authorIsBot", "channelId", "contentText", "createdAt", "id", "serverId" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
